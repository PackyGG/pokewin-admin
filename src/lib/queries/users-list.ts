import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import { user_role } from "@/generated/prisma/enums";
import {
  computeRiskScoresForList,
  type RiskScoreLite,
  type RiskTier,
} from "@/lib/fraud/score";
import {
  officialStreamAdjustmentSqlPredicate,
  removeLockedBalanceAdjustmentSqlPredicate,
} from "@/lib/balance-adjustment-categories";
import { calculateUsersPnlBatch, type UserPnl } from "./pnl";
import { isUserId, isUuid } from "@/lib/utils/ids";
import { getExcludedUserIdsForAdminSearch } from "@/lib/excluded-users/search-visible-override";
import { escapeBlacklistIds } from "./_blacklist";
import { logError } from "@/lib/errors/logger";

// Allowlist from the generated Prisma user_role enum — validate the
// role filter before it reaches either the Prisma where or the raw-SQL
// sort branch, instead of an unchecked cast.
const USER_ROLES = new Set<string>(Object.values(user_role));

// These computed sorts need raw SQL because the displayed value combines
// multiple tables (e.g. totalWithdrawn = balances.total_withdrawn +
// card_withdrawal_requests; netHoldings = balances + user_inventory).
// depositCount lives on ledger_transactions (not on balances) so it
// also has to JOIN-and-COUNT before the ORDER BY can read it. Defined at
// module scope so both getUsers and the cached ranking helper share one
// source of truth for which sorts take the heavy raw-SQL path.
const RAW_SQL_SORTS = new Set([
  "pnl",
  "totalWithdrawn",
  "inventoryValue",
  "netHoldings",
  "depositCount",
]);

/**
 * How a free-form (non-UUID / non-email / non-discord) search term is
 * matched against the handle columns.
 *
 *   "prefix"    → `LOWER(col) LIKE lower(term) || '%'` — a left-anchored
 *                 match. This is the DEFAULT and the big perf win: a
 *                 left-anchored pattern is sargable, so with the
 *                 recommended `text_pattern_ops` index on lower(username) /
 *                 lower(email) / lower(name) / lower(display_username) (see
 *                 prisma/recommended-indexes.sql) it becomes an index RANGE
 *                 scan instead of a full sequential scan of every user on
 *                 every keystroke. Typing a handle prefix ("jo", "joh", …)
 *                 is the overwhelmingly common admin case and this is what
 *                 makes it feel instant.
 *   "substring" → `LOWER(col) LIKE '%' || lower(term) || '%'` — the legacy
 *                 leading-wildcard match. A leading `%` can NEVER use a
 *                 btree, so this is a full seq scan unless the pg_trgm GIN
 *                 index (recommended-indexes.sql) is present. Offered ONLY
 *                 as a deliberate fallback (URL flag `?match=contains`) for
 *                 the rarer "find a handle by an interior fragment" case.
 */
export type UserSearchMode = "prefix" | "substring";

/**
 * Inputs the raw-SQL ranking scan needs, all serializable so the result
 * can be memoised with `unstable_cache` (which keys on the stringified
 * args). The search-shape flags (isExactId / isEmailLike / isDiscordId) are
 * computed once in getUsers and threaded through so the cached SQL build
 * matches the Prisma-path routing exactly.
 */
type UserListFilterInput = {
  searchTerm: string | undefined;
  isExactId: boolean;
  isEmailLike: boolean;
  isDiscordId: boolean;
  /** Prefix (default, index-backed) vs substring (leading-wildcard) match. */
  searchMode: UserSearchMode;
  role: string | undefined;
  status: string | undefined;
  /** packy.gg user_ids from admin `excluded_users` — hidden from list results. */
  excludedUserIds: string[];
};

/** AND-wrap a Prisma where with the analytics blacklist exclusion. */
function withExcludedUsers(
  where: Prisma.UserWhereInput,
  excludedIds: string[],
): Prisma.UserWhereInput {
  if (excludedIds.length === 0) return where;
  return { AND: [where, { id: { notIn: excludedIds } }] };
}

type RankedUserIdsInput = UserListFilterInput & {
  sortBy: string;
  order: "asc" | "desc";
  page: number;
  perPage: number;
};

type RankedUserIdsResult = {
  ids: string[];
  total: number;
};

/** Satellite-aggregate CTE keys a computed sort can request. */
type AggregateKey = "inv" | "cw" | "vc" | "dc" | "osrl";

/**
 * Which satellite aggregates each computed sort needs (balances always joined).
 *
 * PnL / netHoldings include the `osrl` ledger CTE — the SIGNED net of
 * `official_stream` (fake balance, hidden everywhere) +
 * `remove_locked_balance` adjustments, via the canonical null-safe
 * predicates in `src/lib/balance-adjustment-categories.ts`. An earlier
 * iteration dropped this carve-out from the ORDER BY in the belief the
 * scan was the dominant cost — prod truth (2026-06-11: 761 users, ~93
 * adjustment rows) is that the filter-first CTE runs in ~11 ms, and
 * omitting it let a streamer with fake balance rank as a top whale.
 * With it, the ranking ORDER BY and the `calculateUsersPnlBatch` display
 * hydration use the same formula; residual display-vs-order drift is only
 * cache staleness (≤300s global / 30s filtered TTL below).
 */
const SORT_AGGREGATE_KEYS: Record<string, readonly AggregateKey[]> = {
  pnl: ["inv", "cw", "vc", "osrl"],
  netHoldings: ["inv", "vc", "osrl"],
  totalWithdrawn: ["cw"],
  inventoryValue: ["inv"],
  depositCount: ["dc"],
};

function buildAggregateCtes(needs: readonly AggregateKey[]): string {
  const parts: string[] = [];
  if (needs.includes("inv")) {
    parts.push(`
      inv AS (
        SELECT ui.user_id,
               COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS inv_value
          FROM user_inventory ui
         INNER JOIN filtered f ON f.id = ui.user_id
         WHERE ui.sold_at IS NULL
           AND ui.exchanged_at IS NULL
           AND ui.withdrawal_locked_at IS NULL
         GROUP BY ui.user_id
      )`);
  }
  if (needs.includes("cw")) {
    parts.push(`
      cw AS (
        SELECT cwr.user_id,
               COALESCE(SUM(cwr.total_value_usd::numeric), 0) AS wd_value
          FROM card_withdrawal_requests cwr
         INNER JOIN filtered f ON f.id = cwr.user_id
         WHERE cwr.status IN ('pending', 'processing', 'shipped', 'completed')
         GROUP BY cwr.user_id
      )`);
  }
  if (needs.includes("vc")) {
    parts.push(`
      vc AS (
        SELECT v.user_id,
               COALESCE(SUM(v.value::numeric), 0) AS voucher_value
          FROM vouchers v
         INNER JOIN filtered f ON f.id = v.user_id
         WHERE v.claimed_at IS NULL
         GROUP BY v.user_id
      )`);
  }
  if (needs.includes("dc")) {
    parts.push(`
      dc AS (
        SELECT lt.user_id,
               COUNT(*)::bigint AS deposit_count
          FROM ledger_transactions lt
         INNER JOIN filtered f ON f.id = lt.user_id
         WHERE lt.type = 'deposit'::ledger_transaction_type
           AND lt.status = 'completed'::ledger_transaction_status
         GROUP BY lt.user_id
      )`);
  }
  if (needs.includes("osrl")) {
    // SIGNED net of official_stream (fake balance) + remove_locked_balance
    // adjustments per user — the same carve-out calculateUsersPnlBatch
    // applies to onSiteBalance, so ORDER BY matches the displayed values.
    // Predicates come from the canonical null-safe (3VL-guarded) helpers in
    // balance-adjustment-categories.ts — NEVER inline/fork the JSON
    // metadata match. Filter-first (INNER JOIN filtered) keeps the scan
    // bounded to the active cohort.
    parts.push(`
      osrl AS (
        SELECT lt.user_id,
               COALESCE(SUM(lt.amount::numeric), 0) AS osrl_net
          FROM ledger_transactions lt
         INNER JOIN filtered f ON f.id = lt.user_id
         WHERE lt.status = 'completed'::ledger_transaction_status
           AND ((${officialStreamAdjustmentSqlPredicate({
             typeColumn: "lt.type",
             metadataColumn: "lt.metadata",
           })})
             OR (${removeLockedBalanceAdjustmentSqlPredicate({
               typeColumn: "lt.type",
               metadataColumn: "lt.metadata",
             })}))
         GROUP BY lt.user_id
      )`);
  }
  return parts.length ? `,\n${parts.join(",\n")}` : "";
}

function buildRankingJoins(needs: readonly AggregateKey[]): string {
  const joins: string[] = ["LEFT JOIN balances b ON b.user_id = f.id"];
  if (needs.includes("inv")) joins.push("LEFT JOIN inv ON inv.user_id = f.id");
  if (needs.includes("cw")) joins.push("LEFT JOIN cw ON cw.user_id = f.id");
  if (needs.includes("vc")) joins.push("LEFT JOIN vc ON vc.user_id = f.id");
  if (needs.includes("dc")) joins.push("LEFT JOIN dc ON dc.user_id = f.id");
  if (needs.includes("osrl"))
    joins.push("LEFT JOIN osrl ON osrl.user_id = f.id");
  return joins.join("\n      ");
}

function buildRankingOrderExpr(sortBy: string): string {
  if (sortBy === "totalWithdrawn") {
    return `COALESCE(b.total_withdrawn::numeric, 0) + COALESCE(cw.wd_value, 0)`;
  }
  if (sortBy === "inventoryValue") {
    return `COALESCE(inv.inv_value, 0)`;
  }
  if (sortBy === "depositCount") {
    return `COALESCE(dc.deposit_count, 0)`;
  }
  // netHoldings / pnl both net out the official_stream +
  // remove_locked_balance ledger carve-out (osrl) so the ORDER BY uses the
  // same on-site-balance formula the hydrated display values use. (Display
  // additionally clamps available at 0 per row; the unclamped key orders
  // identically for all realistic rows and stays a single SQL expression.)
  if (sortBy === "netHoldings") {
    return `COALESCE(b.available_balance::numeric, 0)
            + COALESCE(b.locked_balance::numeric, 0)
            + COALESCE(inv.inv_value, 0)
            + COALESCE(vc.voucher_value, 0)
            - COALESCE(osrl.osrl_net, 0)`;
  }
  // pnl — user-perspective sort key (asc = biggest user losers = house
  // gain; the toolbar "Top losers" button sends asc).
  return `COALESCE(b.total_withdrawn::numeric, 0) + COALESCE(cw.wd_value, 0)
          + COALESCE(b.available_balance::numeric, 0)
          + COALESCE(b.locked_balance::numeric, 0)
          + COALESCE(inv.inv_value, 0)
          + COALESCE(vc.voucher_value, 0)
          - COALESCE(b.total_deposited::numeric, 0)
          - COALESCE(osrl.osrl_net, 0)`;
}

/** A WHERE clause + the positional bind values it references ($1, $2, …). */
type UserListWhereClause = {
  sql: string;
  params: unknown[];
};

/**
 * Shared WHERE builder for every raw-SQL user-list path (ranking scan AND
 * the column-sort search fast path). Free-form text uses `LOWER(col) LIKE`
 * — NOT Prisma ILIKE — so Postgres can use the recommended lower(col)
 * text_pattern_ops / pg_trgm indexes.
 *
 * The search TERM is bound as a SQL parameter ($1/$2), never interpolated
 * — categorical injection safety on top of the Zod length clamp. LIKE
 * wildcards in the pasted term are escaped in JS (`\` escape char +
 * `ESCAPE '\'`) so a literal `%` / `_` matches literally and the prefix
 * semantics stay honest. Role/status remain enum-allowlisted literals;
 * blacklist ids stay adminDB-sourced + escaped via escapeBlacklistIds.
 *
 * Both statements of each caller (page slice + COUNT) embed the SAME
 * clause, so they pass the SAME params array.
 */
function buildUserListWhereClause(
  input: UserListFilterInput,
): UserListWhereClause {
  const {
    searchTerm,
    isExactId,
    isEmailLike,
    isDiscordId,
    searchMode,
    role,
    status,
  } = input;
  const whereSql: string[] = [];
  const params: unknown[] = [];
  if (searchTerm) {
    if (isExactId) {
      params.push(searchTerm);
      // Primary-key lookup — exact match first, then case-insensitive fallback
      // for pasted ids with different casing (nanoid ids are mixed-case).
      whereSql.push(`(u.id = $1 OR LOWER(u.id) = LOWER($1))`);
    } else if (isEmailLike) {
      params.push(searchTerm);
      whereSql.push(`LOWER(u.email) = LOWER($1)`);
    } else if (isDiscordId) {
      params.push(searchTerm);
      whereSql.push(
        `EXISTS (SELECT 1 FROM account a WHERE a."userId" = u.id AND a."providerId" = 'discord' AND a."accountId" = $1)`,
      );
    } else {
      // Pattern computed in JS: lowercase (SQL side compares LOWER(col)),
      // then escape `\` / `%` / `_` so pasted wildcards match literally.
      const lowered = searchTerm.toLowerCase();
      const escaped = lowered.replace(/[\\%_]/g, "\\$&");
      const pattern =
        searchMode === "substring" ? `%${escaped}%` : `${escaped}%`;
      params.push(pattern); // $1 — LIKE pattern
      params.push(lowered); // $2 — raw lowered term (exact-id leg)
      // UNION per column so Postgres can index-range each leg instead of
      // OR-ing four ILIKE predicates (which often devolves to a seq scan).
      whereSql.push(
        `u.id IN (
          SELECT id FROM (
            SELECT id FROM "user" WHERE LOWER(username) LIKE $1 ESCAPE '\\'
            UNION
            SELECT id FROM "user" WHERE LOWER(display_username) LIKE $1 ESCAPE '\\'
            UNION
            SELECT id FROM "user" WHERE LOWER(name) LIKE $1 ESCAPE '\\'
            UNION
            SELECT id FROM "user" WHERE LOWER(email) LIKE $1 ESCAPE '\\'
            UNION
            SELECT id FROM "user" WHERE LOWER(id) LIKE $1 ESCAPE '\\'
            UNION
            SELECT id FROM "user" WHERE LOWER(id) = $2
          ) matched
        )`,
      );
    }
  }
  if (role && role !== "all" && USER_ROLES.has(role)) {
    whereSql.push(`u.role = '${role}'::user_role`);
  }
  if (status === "banned") whereSql.push("u.is_banned = true");
  else if (status === "locked") whereSql.push("u.is_locked = true");
  else if (status === "active")
    whereSql.push("u.is_banned = false AND u.is_locked = false");
  if (input.excludedUserIds.length > 0) {
    whereSql.push(
      `u.id NOT IN (${escapeBlacklistIds(input.excludedUserIds)})`,
    );
  }
  return {
    sql: whereSql.length ? `WHERE ${whereSql.join(" AND ")}` : "",
    params,
  };
}

function buildUserListColumnOrderSql(
  sortBy: string,
  order: "asc" | "desc",
): { orderSql: string; needsBalanceJoin: boolean } {
  const orderSql = order === "asc" ? "ASC" : "DESC";
  if (sortBy === "balance") {
    return {
      needsBalanceJoin: true,
      orderSql: `ORDER BY b.available_balance ${orderSql} NULLS LAST, u.id ASC`,
    };
  }
  if (sortBy === "totalDeposited") {
    return {
      needsBalanceJoin: true,
      orderSql: `ORDER BY b.total_deposited ${orderSql} NULLS LAST, u.id ASC`,
    };
  }
  if (sortBy === "totalWagered") {
    return {
      needsBalanceJoin: true,
      orderSql: `ORDER BY b.total_wagered ${orderSql} NULLS LAST, u.id ASC`,
    };
  }
  if (sortBy === "status") {
    return {
      needsBalanceJoin: false,
      orderSql: `ORDER BY u.is_banned ${orderSql}, u.is_locked ${orderSql}, u.id ASC`,
    };
  }
  const userSortFields = new Set([
    "created_at",
    "email",
    "username",
    "role",
    "country",
  ]);
  const field = userSortFields.has(sortBy) ? sortBy : "created_at";
  return {
    needsBalanceJoin: false,
    orderSql: `ORDER BY u.${field} ${orderSql} NULLS LAST, u.id ASC`,
  };
}

type ColumnSortUserIdsInput = UserListFilterInput & {
  sortBy: string;
  order: "asc" | "desc";
  page: number;
  perPage: number;
};

/**
 * Index-friendly ID fetch for column sorts when free-form text search is
 * active. Prisma `startsWith` + `mode:"insensitive"` compiles to ILIKE,
 * which cannot use the lower(col) text_pattern_ops indexes.
 */
async function fetchColumnSortUserIds(
  input: ColumnSortUserIdsInput,
): Promise<{ ids: string[]; total: number }> {
  const { sortBy, order, page, perPage, ...filter } = input;
  const db = await getDb();
  const whereClause = buildUserListWhereClause(filter);
  const { orderSql, needsBalanceJoin } = buildUserListColumnOrderSql(
    sortBy,
    order,
  );
  const balanceJoin = needsBalanceJoin
    ? "LEFT JOIN balances b ON b.user_id = u.id"
    : "";

  // COUNT(*) stays EXACT — measured 0.2–2.7 ms at prod size (761 users,
  // 2026-06-11). If `user` ever grows past ~500k rows, switch the
  // UNFILTERED total to a `pg_class.reltuples` estimate; filtered counts
  // stay exact.
  const [orderedRows, totalCount] = await Promise.all([
    db.$queryRawUnsafe<{ id: string }[]>(
      `
      SELECT u.id
      FROM "user" u
      ${balanceJoin}
      ${whereClause.sql}
      ${orderSql}
      LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
    `,
      ...whereClause.params,
    ),
    db.$queryRawUnsafe<{ c: string }[]>(
      `
      SELECT COUNT(*)::text AS c FROM "user" u ${whereClause.sql}
    `,
      ...whereClause.params,
    ),
  ]);

  return {
    ids: orderedRows.map((r) => r.id),
    total: Number(totalCount[0]?.c ?? 0),
  };
}

const cachedFilteredColumnSortUserIds = unstable_cache(
  fetchColumnSortUserIds,
  ["users-column-sort-filtered-v3"],
  { revalidate: 30, tags: ["users-list"] },
);

/**
 * The expensive half of the computed-sort path: a global ORDER BY over the
 * whole `user` table joined to per-user inventory / card-withdrawal /
 * voucher / ledger-carve-out (and optionally deposit-count) aggregate
 * subqueries, returning just the ordered slice of user IDs + the total row
 * count for the active filter. Prod currently has NO supporting indexes
 * for these expressions (prisma/recommended-indexes.sql is unapplied), so
 * this is the heaviest query on the page — though at today's prod size
 * (761 users, 2026-06-11) it measures ~11 ms; the 30s DB
 * statement_timeout + the page-level safeQuery wall clock are the real
 * safety nets, not query cost.
 *
 * Kept separate from the row hydration (findMany + PnL batch + risk
 * scores) on purpose: the ranking depends ONLY on the serializable
 * (sort / filter / page) inputs, so it can be cached cross-request, while
 * the hydration reads LIVE per-row values that must stay fresh. See
 * cachedRankedUserIds below.
 *
 * Returns `{ ids, total }`; ids is already in display order. Selects
 * `f.id` ONLY — per-row financials are hydrated truthfully by
 * calculateUsersPnlBatch in hydrateUserListPage (one path, no precomputed
 * metric forks).
 */
async function computeRankedUserIds(
  input: RankedUserIdsInput,
): Promise<RankedUserIdsResult> {
  const { sortBy, order, page, perPage, ...filter } = input;
  const db = await getDb();
  const orderSql = order === "asc" ? "ASC" : "DESC";
  const whereClause = buildUserListWhereClause(filter);
  const aggregateKeys = SORT_AGGREGATE_KEYS[sortBy] ?? [];
  const aggregateCtes = buildAggregateCtes(aggregateKeys);
  const rankingJoins = buildRankingJoins(aggregateKeys);
  const orderExpr = buildRankingOrderExpr(sortBy);

  // COUNT(*) stays EXACT — see fetchColumnSortUserIds for the upgrade path
  // (switch the unfiltered total to a reltuples estimate past ~500k rows).
  const [orderedRows, totalCount] = await Promise.all([
    db.$queryRawUnsafe<{ id: string }[]>(
      `
      WITH filtered AS (
        SELECT u.id
          FROM "user" u
          ${whereClause.sql}
      )${aggregateCtes}
      SELECT f.id
        FROM filtered f
        ${rankingJoins}
       ORDER BY (${orderExpr}) ${orderSql} NULLS LAST, f.id ${orderSql}
       LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
    `,
      ...whereClause.params,
    ),
    db.$queryRawUnsafe<{ c: string }[]>(
      `
      SELECT COUNT(*)::text AS c FROM "user" u ${whereClause.sql}
    `,
      ...whereClause.params,
    ),
  ]);

  return {
    ids: orderedRows.map((r) => r.id),
    total: Number(totalCount[0]?.c ?? 0),
  };
}

/**
 * Cached wrapper around the heavy ranking scan, split by whether a
 * search/role/status FILTER is active.
 *
 * The legacy single cache keyed on the FULL input tuple (sort / order /
 * page / perPage / search / role / status). That made the cache nearly
 * useless for the case it most needed to help: a typed search. Every
 * keystroke is a distinct `search` value → a distinct cache key → a
 * guaranteed miss, so the heavy ranking ran fresh on every keystroke
 * anyway while the cache only ever helped the unfiltered default view.
 *
 * The split below matches the cache TTL to how the two cases actually
 * behave:
 *
 *  • UNFILTERED (no search / role / status) → {@link cachedGlobalRankedUserIds},
 *    5-minute TTL. This is the genuinely heavy, slowly-moving case — a
 *    GLOBAL ORDER BY over the whole user base (the "Top winners / Top
 *    losers" lifetime-PnL ranking). A single user's play barely perturbs
 *    the top-N, so a long TTL is correct: the first request after a cold
 *    cache pays the scan once and every page click within the window
 *    (same sort, deeper page) is served from cache. Keyed on
 *    sort/order/page/perPage only (the filter fields are empty here).
 *
 *  • FILTERED (any of search / role / status set) → {@link cachedFilteredRankedUserIds},
 *    30-second TTL. After the filter-first restructure in
 *    computeRankedUserIds these queries are cheap (they aggregate only the
 *    matched users, not the whole base), so they don't need a long cache
 *    to be fast — a short TTL still collapses the duplicate calls a single
 *    render fans out (and rapid re-paging of the same search) without
 *    serving a stale member list as admins ban/lock users. Distinct cache
 *    namespace so a filtered slice can never return an unfiltered view's
 *    IDs.
 *
 * Both keep the hydration step in getUsers UNCACHED, so per-row balances /
 * PnL / risk are always live even when the ID ordering is served from
 * cache.
 *
 * `getDb()` inside each cache callback resolves to the prod client (its
 * cookie read falls back to prod outside a request scope — see
 * readDbEnv), which is the right behaviour for a cross-request ranking
 * cache: it must not be keyed to one admin's dev-DB toggle. This mirrors
 * the existing getUsersListStats cache below.
 */
const cachedGlobalRankedUserIds = unstable_cache(
  computeRankedUserIds,
  ["users-ranked-ids-global-v6"],
  { revalidate: 300, tags: ["users-list"] },
);

const cachedFilteredRankedUserIds = unstable_cache(
  computeRankedUserIds,
  ["users-ranked-ids-filtered-v6"],
  { revalidate: 30, tags: ["users-list"] },
);

/**
 * Route a ranking request to the long-TTL global cache when no filter is
 * active, or the short-TTL filtered cache otherwise. A search term, role
 * filter, or status filter all count as "filtered".
 */
function cachedRankedUserIds(
  input: RankedUserIdsInput,
): Promise<RankedUserIdsResult> {
  const isFiltered =
    !!input.searchTerm ||
    (!!input.role && input.role !== "all") ||
    !!input.status;
  return isFiltered
    ? cachedFilteredRankedUserIds(input)
    : cachedGlobalRankedUserIds(input);
}

type UserListItem = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  status: string;
  country: string | null;
  countryCode: string | null;
  availableBalance: number;
  inventoryValue: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalWagered: number;
  depositCount: number;
  pnl: number;
  /**
   * Combined on-platform holdings = available + locked balance +
   * unsold/unexchanged inventory value + unclaimed voucher value.
   * Vouchers count as inventory exactly like cards (cards + vouchers
   * = inventory), so they're part of the on-site position. This is the
   * user's TOTAL position on-site right now, which from the house POV
   * is the direct liability per user. Useful for spotting whales
   * without having to mentally add the Balance + Inventory columns.
   */
  netHoldings: number;
  createdAt: string;
  riskScore: number;
  riskTier: RiskTier;
  sharedIpCount: number;
  sharedFingerprintCount: number;
};

const USER_LIST_SELECT = {
  id: true,
  username: true,
  email: true,
  image: true,
  role: true,
  is_banned: true,
  is_locked: true,
  country: true,
  country_code: true,
  created_at: true,
  balances: {
    select: {
      available_balance: true,
      locked_balance: true,
      total_deposited: true,
      total_withdrawn: true,
      total_wagered: true,
    },
  },
} satisfies Prisma.UserSelect;

type UserListRow = Prisma.UserGetPayload<{ select: typeof USER_LIST_SELECT }>;

/**
 * Hydrate the page slice with live per-row financials + risk badges.
 *
 * ONE truthful path — the old 4-mode variant (skipPnlBatch /
 * skipListRisk / precomputedMetrics / rankedSortBy) rendered $0.00
 * P&L/Inventory/Net on exact-match searches and on the computed-sort
 * pages whenever its mode routing skipped the batch. Now every render:
 *
 *  • `calculateUsersPnlBatch` (6 parallel PK-IN queries, canonical
 *    null-safe official_stream / remove_locked carve-outs) — a failure
 *    THROWS so the page-level safeQuery shows the visible failure band.
 *    Money columns are the page's core content; silently falling back to
 *    the balances row would render numbers that are confidently wrong.
 *  • deposit-count groupBy (Prisma enum literal — drift-safe).
 *  • `computeRiskScoresForList` — advisory badge only, so its failure is
 *    CAUGHT, logged, and degraded to empty (a missing badge must never
 *    blank the whole list — the user_battle_limits lesson class). It now
 *    runs on EVERY path including search: a "low" badge on a searched
 *    fraudster is the same lying-zero class as $0 P&L.
 */
async function hydrateUserListPage(
  users: UserListRow[],
  total: number,
  page: number,
  perPage: number,
): Promise<PaginatedResult<UserListItem>> {
  const db = await getDb();
  const userIds = users.map((u) => u.id);
  const emptyDeposits: Array<{ user_id: string; _count: { _all: number } }> =
    [];
  const emptyRisk = new Map<string, RiskScoreLite>();

  const [pnlByUserId, depositCountRows, riskScoresMap] = await Promise.all([
    userIds.length > 0
      ? calculateUsersPnlBatch(userIds)
      : Promise.resolve(new Map<string, UserPnl>()),
    userIds.length > 0
      ? db.ledger_transactions.groupBy({
          by: ["user_id"],
          where: {
            user_id: { in: userIds },
            type: "deposit",
            status: "completed",
          },
          _count: { _all: true },
        })
      : Promise.resolve(emptyDeposits),
    userIds.length > 0
      ? computeRiskScoresForList(userIds).catch((err) => {
          logError(
            "users.list.risk",
            "risk batch degraded — rendering rows without risk badges",
            err,
          );
          return emptyRisk;
        })
      : Promise.resolve(emptyRisk),
  ]);

  const depositCountMap = new Map(
    depositCountRows.map((d) => [d.user_id, d._count._all]),
  );

  return {
    data: users.map((u) => {
      const lockedBalance = toNumber(u.balances?.locked_balance);
      const totalWagered = toNumber(u.balances?.total_wagered);
      // The batch writes a record for EVERY requested id (zeroed when the
      // user has no rows), so `get` only misses if the id wasn't in
      // userIds — structurally impossible here. The guard is TS narrowing,
      // not a silent data fallback: a failed batch THROWS above.
      const userPnl = pnlByUserId.get(u.id);
      const availableBalance = userPnl
        ? Math.max(0, userPnl.onSiteBalance - lockedBalance)
        : 0;
      const totalDeposited = userPnl?.deposits ?? 0;
      const totalWithdrawn = userPnl?.withdrawals ?? 0;
      const inventoryValue = userPnl?.inventoryValue ?? 0;
      const unclaimedVouchers = userPnl?.unclaimedVouchers ?? 0;
      // House formula → user-perspective sign for the column (positive =
      // user in profit = rose per house-POV color rules).
      const pnl = userPnl ? -userPnl.pnl : 0;
      const netHoldings =
        availableBalance + lockedBalance + inventoryValue + unclaimedVouchers;
      const risk = riskScoresMap.get(u.id);
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        image: u.image,
        role: u.role,
        status: u.is_banned ? "banned" : u.is_locked ? "locked" : "active",
        country: u.country,
        countryCode: u.country_code,
        availableBalance,
        inventoryValue,
        netHoldings,
        totalDeposited,
        totalWithdrawn,
        totalWagered,
        depositCount: depositCountMap.get(u.id) ?? 0,
        pnl,
        createdAt: u.created_at.toISOString(),
        riskScore: risk?.score ?? 0,
        riskTier: risk?.tier ?? ("low" as RiskTier),
        sharedIpCount: risk?.sharedIpCount ?? 0,
        sharedFingerprintCount: risk?.sharedFingerprintCount ?? 0,
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getUsers(params: {
  page?: number;
  perPage?: number;
  search?: string;
  role?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: string;
  /**
   * How a free-form handle/name search is matched. Defaults to "prefix"
   * (left-anchored, index-backed). Pass "substring" to opt into the
   * legacy leading-wildcard `%term%` interior match (slower; backed only
   * by the pg_trgm GIN index). UUID / email / discord-id searches ignore
   * this — they always route to their exact-match fast path.
   */
  searchMode?: UserSearchMode;
  /**
   * When true AND a search term is present, excluded (blacklisted) users
   * are included in results. Only set after `canCurrentAdminIncludeExcludedInSearch`.
   */
  includeExcludedInSearch?: boolean;
}): Promise<PaginatedResult<UserListItem>> {
  const db = await getDb();
  const {
    page = 1,
    perPage = 20,
    search,
    role,
    status,
    sortBy = "created_at",
    sortOrder = "desc",
    searchMode = "prefix",
    includeExcludedInSearch = false,
  } = params;

  const searchTerm = search?.trim();
  const isAnySearch = !!searchTerm;

  const excludedUserIds = await getExcludedUserIdsForAdminSearch({
    includeAllBlacklisted: includeExcludedInSearch,
    isSearching: isAnySearch,
  });

  const where: Prisma.UserWhereInput = {};

  // Trim so stray leading/trailing whitespace (easy to paste in by
  // accident) doesn't turn a valid handle into a miss.

  // ── Search fast paths ──────────────────────────────────────────────
  // The legacy code path ORed 4× ILIKE '%term%' across username /
  // display_username / name / email. ILIKE with a LEADING % can't use
  // ANY btree, so every keystroke triggered a full sequential scan of
  // the `user` table. (Prod is 761 rows as of 2026-06-11 — small enough
  // that the scan itself is cheap today; the shape routing below is
  // about staying index-backed as the table grows, once the recommended
  // indexes are applied.)
  //
  // Two-tier fix:
  //   1. SHAPE FAST PATHS (unchanged) — route to an equality lookup
  //      (O(log n) on a unique index) for inputs that don't need pattern
  //      matching: UUIDs (= primary key), email-format strings (= unique
  //      email index), and Discord snowflakes (= account join).
  //   2. PREFIX matching for free-form handle/name text (the common
  //      "typed a partial handle" case). `startsWith` compiles to a
  //      left-anchored `ILIKE 'term%'`, which IS sargable — with the
  //      recommended lower(col) text_pattern_ops indexes (see
  //      prisma/recommended-indexes.sql) it is an index RANGE scan
  //      instead of a full table scan. This is the big win and the new
  //      default. The rarer "match an interior fragment" case is still
  //      available via searchMode === "substring" (legacy `contains` /
  //      `%term%`), which needs the pg_trgm GIN index to be fast.
  const isExactId =
    !!searchTerm && (isUuid(searchTerm) || isUserId(searchTerm));
  // Cheap email shape check — anything with an @ that isn't trivially
  // malformed. We don't require a full RFC-compliant match; the unique
  // email index settles the result either way.
  const isEmailLike =
    !!searchTerm && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(searchTerm);
  // Discord snowflake IDs are 17-20 digit numeric strings. We match the
  // linked Discord account (account.providerId = 'discord', account.accountId
  // = snowflake) only when the search looks like one — otherwise a generic
  // numeric username would trigger an unnecessary join.
  const isDiscordId = /^\d{17,20}$/.test(searchTerm ?? "");
  const isFreeFormTextSearch =
    !!searchTerm && !isExactId && !isEmailLike && !isDiscordId;
  // Free-form / exact-match SEARCH must not run the computed-sort ranking
  // scan — that was the main source of 15s timeouts on ?search=…. Role /
  // status toolbar filters are safe: computeRankedUserIds is filter-first
  // (aggregates only matched users) and is cached via
  // cachedFilteredRankedUserIds (30s TTL). Skipping ranking for toolbar
  // filters broke "Top user net worth" (?role=user&sortBy=netHoldings),
  // which fell back to created_at on the server while the client re-sorted
  // only the current page slice by netHoldings.
  const skipHeavyRanking = isAnySearch;
  const filterInput: UserListFilterInput = {
    searchTerm,
    isExactId,
    isEmailLike,
    isDiscordId,
    searchMode,
    role,
    status,
    excludedUserIds,
  };

  // ── Exact-match fast path (user id / email / discord snowflake) ───────
  // Single indexed lookup — never touch the global PnL ranking scan or
  // the heavy raw-SQL sort path. Case on user id is ignored (OR + Prisma
  // insensitive). This is what admins paste from the URL bar.
  if (isAnySearch && (isExactId || isEmailLike || isDiscordId)) {
    const exactWhere: Prisma.UserWhereInput = {};
    if (isExactId) {
      exactWhere.OR = [
        { id: searchTerm },
        { id: { equals: searchTerm, mode: "insensitive" } },
      ];
    } else if (isEmailLike) {
      exactWhere.email = { equals: searchTerm, mode: "insensitive" };
    } else if (isDiscordId) {
      exactWhere.account = {
        some: { providerId: "discord", accountId: searchTerm },
      };
    }
    if (role && role !== "all" && USER_ROLES.has(role)) {
      exactWhere.role = role as user_role;
    }
    if (status === "banned") exactWhere.is_banned = true;
    else if (status === "locked") exactWhere.is_locked = true;
    else if (status === "active") {
      exactWhere.is_banned = false;
      exactWhere.is_locked = false;
    }

    const exactWhereFiltered = withExcludedUsers(exactWhere, excludedUserIds);

    const [exactUsers, exactTotal] = await Promise.all([
      db.user.findMany({
        where: exactWhereFiltered,
        select: USER_LIST_SELECT,
        orderBy: { created_at: "desc" },
        take: perPage,
        skip: (page - 1) * perPage,
      }),
      db.user.count({ where: exactWhereFiltered }),
    ]);

    // Full truthful hydration — the old `skipPnlBatch: true` here is what
    // rendered $0.00 P&L / Inventory / Net for every exact-match search.
    return hydrateUserListPage(exactUsers, exactTotal, page, perPage);
  }

  if (searchTerm) {
    if (isExactId) {
      // Primary-key lookup — single index hit. mode insensitive so pasted
      // ids with different casing still resolve (nanoid ids are mixed-case).
      where.id = { equals: searchTerm, mode: "insensitive" };
    } else if (isEmailLike) {
      // user.email has a unique index — equality lookup is O(log n).
      // mode insensitive normalises case for the rare user whose
      // email was stored mixed-case before the lowercasing pass.
      where.email = { equals: searchTerm, mode: "insensitive" };
    } else if (isDiscordId) {
      // account.accountId is indexed; the EXISTS subquery is a single
      // index seek per matching row.
      where.account = {
        some: { providerId: "discord", accountId: searchTerm },
      };
    } else {
      // Free-form handle/name match. Search the handle, the display name
      // + OAuth name (so a user can be found by what Discord/Google
      // shows, not just the lowercase handle), and the email; id is
      // included for short partial UUID pastes that didn't pass UUID_RE.
      // Only runs when the input shape didn't match any fast path above.
      //
      // PREFIX by default: `startsWith` → left-anchored `ILIKE 'term%'`,
      // sargable against the recommended lower(col) text_pattern_ops
      // indexes (index range scan, not a full seq scan). SUBSTRING
      // (`contains` → `%term%`) is the opt-in interior-fragment fallback
      // and stays a seq scan until the pg_trgm GIN index is applied.
      // The matcher is chosen ONCE so the four handle/name legs stay
      // consistent; `mode: "insensitive"` lowercases both sides exactly
      // as the raw-SQL ranking path's LOWER(col) LIKE LOWER(term) does,
      // so the Prisma-path and ranking-path result sets agree.
      const textMatch =
        searchMode === "substring"
          ? { contains: searchTerm, mode: "insensitive" as const }
          : { startsWith: searchTerm, mode: "insensitive" as const };
      where.OR = [
        { username: textMatch },
        { display_username: textMatch },
        { name: textMatch },
        { email: textMatch },
        { id: { equals: searchTerm, mode: "insensitive" } },
      ];
    }
  }

  if (role && role !== "all" && USER_ROLES.has(role)) {
    where.role = role as user_role;
  }

  if (status === "banned") where.is_banned = true;
  else if (status === "locked") where.is_locked = true;
  else if (status === "active") {
    where.is_banned = false;
    where.is_locked = false;
  }

  const order = sortOrder === "asc" ? "asc" : "desc";
  const balanceSortFields = new Set([
    "balance",
    "totalDeposited",
    "totalWagered",
  ]);
  const userSortFields = new Set([
    "created_at",
    "email",
    "username",
    "role",
    "country",
  ]);

  // Narrow projection — see USER_LIST_SELECT at module scope.
  const userSelect = USER_LIST_SELECT;

  let users: UserListRow[];
  let total: number;

  // Never run the computed-sort ranking scan while a search filter is
  // active — that was the main source of 15s timeouts on ?search=….
  // Text / id searches use the index-friendly column-sort SQL instead
  // (see branch below). Role / status filters route to the filter-first
  // ranking path (cachedFilteredRankedUserIds).
  if (RAW_SQL_SORTS.has(sortBy) && !skipHeavyRanking) {
    // Heavy computed-sort path. The global ORDER BY scan (the source of
    // the "/users timed out" failure — most acutely the Top winners /
    // Top losers lifetime-PnL ranking) is delegated to the cached
    // ranking helper, which memoises the ordered ID slice + total for
    // this (sort / filter / page) tuple with a long TTL. Page row
    // HYDRATION stays here and stays UNCACHED so balances / PnL / risk
    // are always live; only the slow ordering is served from cache.
    const { ids, total: totalCount } = await cachedRankedUserIds({
      ...filterInput,
      sortBy,
      order,
      page,
      perPage,
    });
    const unordered =
      ids.length > 0
        ? await db.user.findMany({
            where: { id: { in: ids } },
            select: userSelect,
          })
        : ([] as typeof users);
    const byId = new Map(unordered.map((u) => [u.id, u]));
    users = ids
      .map((id) => byId.get(id))
      .filter((u): u is (typeof unordered)[number] => Boolean(u));
    total = totalCount;

    // Server row order is preserved (ids → findMany → reorder map above);
    // hydration fills live financials via the PnL batch. The ORDER BY and
    // the displayed values share one formula (osrl carve-out in both), so
    // the only residual display-vs-order drift is ranking-cache staleness
    // (≤300s global / 30s filtered TTL).
    return hydrateUserListPage(users, total, page, perPage);
  } else {
    // Build a compound orderBy so every Prisma-path sort gets a
    // deterministic tie-breaker (id ASC). Without it, many users with
    // identical $0 balance / NULL totals come back in arbitrary
    // Postgres-internal order across page navigations, which is what
    // makes "sort by Balance" look broken once the page scrolls past
    // the handful of non-zero balances.
    let orderBy: Prisma.UserOrderByWithRelationInput[];
    if (balanceSortFields.has(sortBy)) {
      const balanceField = (
        {
          balance: "available_balance",
          totalDeposited: "total_deposited",
          totalWagered: "total_wagered",
        } as Record<string, string>
      )[sortBy];
      orderBy = [
        {
          balances: {
            [balanceField]: order,
          } as Prisma.balancesOrderByWithRelationInput,
        },
        { id: "asc" },
      ];
    } else if (sortBy === "status") {
      // Computed status = "banned" | "locked" | "active".  Prisma
      // can't ORDER BY a derived expression, so we sort by the two
      // boolean columns the status string is derived from. For DESC
      // order, banned (true) sorts before locked (true) sorts before
      // active (both false) — which matches the alphabetical reading
      // a user expects when they click "Status DESC".
      orderBy = [
        { is_banned: order },
        { is_locked: order },
        { id: "asc" },
      ];
    } else {
      const field = userSortFields.has(sortBy) ? sortBy : "created_at";
      orderBy = [
        { [field]: order } as Prisma.UserOrderByWithRelationInput,
        { id: "asc" },
      ];
    }

    if (
      isFreeFormTextSearch ||
      (skipHeavyRanking && RAW_SQL_SORTS.has(sortBy))
    ) {
      const effectiveSort =
        skipHeavyRanking && RAW_SQL_SORTS.has(sortBy) ? "created_at" : sortBy;
      const { ids, total: totalCount } = await cachedFilteredColumnSortUserIds(
        {
          ...filterInput,
          sortBy: effectiveSort,
          order,
          page,
          perPage,
        },
      );
      const unordered =
        ids.length > 0
          ? await db.user.findMany({
              where: { id: { in: ids } },
              select: userSelect,
            })
          : ([] as typeof users);
      const byId = new Map(unordered.map((u) => [u.id, u]));
      users = ids
        .map((id) => byId.get(id))
        .filter((u): u is (typeof unordered)[number] => Boolean(u));
      total = totalCount;
    } else {
      const whereFiltered = withExcludedUsers(where, excludedUserIds);
      const result = await Promise.all([
        db.user.findMany({
          where: whereFiltered,
          orderBy,
          skip: (page - 1) * perPage,
          take: perPage,
          select: userSelect,
        }),
        db.user.count({ where: whereFiltered }),
      ]);
      users = result[0];
      total = result[1];
    }
  }

  return hydrateUserListPage(users, total, page, perPage);
}

// ─── Global KPI stats for the /users page hero strip ──────────────────
//
// Counts that describe the WHOLE user base, independent of the current
// page / search / role / status filter. The headline tiles on /users
// read off this so they stay stable as admins paginate or refine the
// table — switching to a search term doesn't make "Banned" suddenly
// read as the banned count of just the current page slice.
//
// Three COUNT(*) FILTER aggregates over the user table in a single
// round-trip — Postgres folds them into a single sequential scan with
// FILTER predicates, so it's strictly cheaper than three Prisma
// .count() calls.
//
// Cached cross-request (60s revalidate) so spamming the search box
// doesn't fan into the DB on every keystroke. unstable_cache also
// deduplicates within a single render, so a Suspense fan-out that
// happens to call this twice gets one query.

export type UsersListStats = {
  /** All users in the DB, regardless of role or status. */
  totalUsers: number;
  /** Users with `is_banned = true`. */
  totalBanned: number;
  /** Users created in the rolling last 24h. */
  signups24h: number;
};

const cachedUsersListStats = unstable_cache(
  async (): Promise<UsersListStats> => {
    const db = await getDb();
    const rows = await db.$queryRaw<
      {
        total: string;
        banned: string;
        signups_24h: string;
      }[]
    >`
      SELECT
        COUNT(*)::text                                                                   AS total,
        COUNT(*) FILTER (WHERE is_banned = true)::text                                   AS banned,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::text          AS signups_24h
      FROM "user"
    `;
    const r = rows[0];
    return {
      totalUsers: Number(r?.total ?? 0),
      totalBanned: Number(r?.banned ?? 0),
      signups24h: Number(r?.signups_24h ?? 0),
    };
  },
  ["users-list-stats-v1"],
  { revalidate: 60, tags: ["users-list-stats"] },
);

export async function getUsersListStats(): Promise<UsersListStats> {
  return cachedUsersListStats();
}
