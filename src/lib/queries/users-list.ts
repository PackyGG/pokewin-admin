import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import { user_role } from "@/generated/prisma/enums";
import {
  computeRiskScoresForList,
  type RiskTier,
} from "@/lib/fraud/score";
import { calculateUsersPnlBatch } from "./pnl";
import { officialStreamAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";
import { isUserId, isUuid } from "@/lib/utils/ids";

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
};

type RankedUserIdsInput = UserListFilterInput & {
  sortBy: string;
  order: "asc" | "desc";
  page: number;
  perPage: number;
};

/**
 * Shared WHERE builder for every raw-SQL user-list path (ranking scan AND
 * the column-sort search fast path). Free-form text uses `LOWER(col) LIKE`
 * — NOT Prisma ILIKE — so Postgres can use the recommended lower(col)
 * text_pattern_ops / pg_trgm indexes.
 */
function buildUserListWhereClause(input: UserListFilterInput): string {
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
  if (searchTerm) {
    const safe = searchTerm.replace(/'/g, "''");
    if (isExactId) {
      whereSql.push(`LOWER(u.id) = LOWER('${safe}')`);
    } else if (isEmailLike) {
      whereSql.push(`LOWER(u.email) = LOWER('${safe}')`);
    } else if (isDiscordId) {
      whereSql.push(
        `EXISTS (SELECT 1 FROM account a WHERE a."userId" = u.id AND a."providerId" = 'discord' AND a."accountId" = '${safe}')`,
      );
    } else {
      const lower = `LOWER('${safe}')`;
      const pattern =
        searchMode === "substring"
          ? `'%' || ${lower} || '%'`
          : `${lower} || '%'`;
      whereSql.push(
        `(LOWER(u.username) LIKE ${pattern} OR LOWER(u.display_username) LIKE ${pattern} OR LOWER(u.name) LIKE ${pattern} OR LOWER(u.email) LIKE ${pattern} OR LOWER(u.id) = LOWER('${safe}'))`,
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
  return whereSql.length ? `WHERE ${whereSql.join(" AND ")}` : "";
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

  const [orderedRows, totalCount] = await Promise.all([
    db.$queryRawUnsafe<{ id: string }[]>(`
      SELECT u.id
      FROM "user" u
      ${balanceJoin}
      ${whereClause}
      ${orderSql}
      LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
    `),
    db.$queryRawUnsafe<{ c: string }[]>(`
      SELECT COUNT(*)::text AS c FROM "user" u ${whereClause}
    `),
  ]);

  return {
    ids: orderedRows.map((r) => r.id),
    total: Number(totalCount[0]?.c ?? 0),
  };
}

const cachedFilteredColumnSortUserIds = unstable_cache(
  fetchColumnSortUserIds,
  ["users-column-sort-filtered-v1"],
  { revalidate: 30, tags: ["users-list"] },
);

/**
 * The expensive half of the computed-sort path: a global ORDER BY over the
 * whole `user` table joined to per-user inventory / card-withdrawal /
 * voucher (and optionally deposit-count) aggregate subqueries, returning
 * just the ordered slice of user IDs + the total row count for the active
 * filter. The main DB lacks the supporting indexes for these expressions,
 * so on a prod-sized table this scan is the heaviest query on the page and
 * was the source of the "/users timed out" failure — especially the
 * "Top winners / Top losers" global PnL ranking, which orders every user
 * by lifetime P&L before paginating.
 *
 * Kept separate from the row hydration (findMany + PnL batch + risk
 * scores) on purpose: the ranking depends ONLY on the serializable
 * (sort / filter / page) inputs, so it can be cached cross-request, while
 * the hydration reads LIVE per-row values that must stay fresh. See
 * cachedRankedUserIds below.
 *
 * Returns `{ ids, total }`; ids is already in display order.
 */
async function computeRankedUserIds(
  input: RankedUserIdsInput,
): Promise<{ ids: string[]; total: number }> {
  const { sortBy, order, page, perPage, ...filter } = input;
  const db = await getDb();
  const orderSql = order === "asc" ? "ASC" : "DESC";
  const whereClause = buildUserListWhereClause(filter);

  // ── Two-stage filter → hydrate ───────────────────────────────────────
  // PERF: the legacy query LEFT-JOINed all 6 per-user aggregates
  // (inventory / withdrawals / vouchers / official-stream / optional
  // deposit-count) onto the WHOLE `user` table and only THEN applied the
  // WHERE — so it computed every aggregate for every user before
  // discarding the ones the filter rejected. With a search term that
  // matches a handful of users, that is thousands of wasted aggregate
  // rows per request.
  //
  // Now the WHERE runs FIRST inside a `filtered` CTE (a plain user-table
  // scan that uses the role/status btree + the prefix index for search),
  // and the aggregate joins hang off that already-narrowed set. Postgres
  // materializes the small filtered id set and aggregates ONLY for those
  // users. The aggregate join SQL is identical to before — only the row
  // it attaches to (the filtered CTE instead of the full table) changed —
  // so the ORDER BY expression, NULLS LAST handling, tie-breaker and
  // pagination are byte-for-byte the same ranking. Result rows are
  // identical to the old query for any given filter.
  //
  // depositCount is the one aggregate JOINed only when it's the active
  // sort key — the COUNT(*) groupBy on ledger_transactions is pricey, so
  // it stays out of every other sort path. It too now aggregates against
  // the filtered set.
  const depositCountJoin =
    sortBy === "depositCount"
      ? `
    LEFT JOIN (
      SELECT user_id, COUNT(*)::bigint AS deposit_count
      FROM ledger_transactions
      WHERE type = 'deposit'::ledger_transaction_type
        AND status = 'completed'::ledger_transaction_status
        AND user_id IN (SELECT id FROM filtered)
      GROUP BY user_id
    ) dc ON dc.user_id = f.id`
      : "";

  const orderExpr =
    sortBy === "totalWithdrawn"
      ? `COALESCE(b.total_withdrawn::numeric, 0) + COALESCE(cw.wd_value, 0)`
      : sortBy === "inventoryValue"
        ? `COALESCE(inv.inv_value, 0)`
        : sortBy === "depositCount"
          ? `COALESCE(dc.deposit_count, 0)`
          : sortBy === "netHoldings"
            ? // Net on-platform position from the house POV: cash
              // (available + locked) + open inventory + unclaimed
              // vouchers. Vouchers count as inventory exactly like
              // cards (cards + vouchers = inventory), so they belong
              // in the on-site holdings snapshot. This is the "what
              // the user has on-site RIGHT NOW" snapshot — ignores
              // lifetime deposits/withdrawals/PnL so big holders
              // surface even if they never wagered. Must stay in sync
              // with the JS netHoldings computed in the data mapping.
              // FAKE-BALANCE: subtract the signed official_stream net
              // (os.os_net) so the sort matches the netted DISPLAYED
              // availableBalance / netHoldings.
              `COALESCE(b.available_balance::numeric, 0)
               + COALESCE(b.locked_balance::numeric, 0)
               + COALESCE(inv.inv_value, 0)
               + COALESCE(vc.voucher_value, 0)
               - COALESCE(os.os_net, 0)`
            : `COALESCE(b.total_withdrawn::numeric, 0) + COALESCE(cw.wd_value, 0)
             + COALESCE(b.available_balance::numeric, 0)
             + COALESCE(b.locked_balance::numeric, 0)
             + COALESCE(inv.inv_value, 0)
             + COALESCE(vc.voucher_value, 0)
             - COALESCE(os.os_net, 0)
             - COALESCE(b.total_deposited::numeric, 0)`;

  // The aggregate subqueries are scoped to the filtered id set via
  // `WHERE user_id IN (SELECT id FROM filtered)`. This is the change that
  // makes the heavy joins cheap: each aggregate now sums only the rows
  // belonging to a user that survived the WHERE, instead of grouping the
  // whole inventory / withdrawals / vouchers / ledger tables.
  const [orderedRows, totalCount] = await Promise.all([
    db.$queryRawUnsafe<{ id: string }[]>(`
      WITH filtered AS (
        SELECT u.id
        FROM "user" u
        ${whereClause}
      )
      SELECT f.id
      FROM filtered f
      LEFT JOIN balances b ON b.user_id = f.id
      LEFT JOIN (
        SELECT user_id, COALESCE(SUM(value_at_obtained::numeric), 0) AS inv_value
        FROM user_inventory
        -- Exclude cards locked for an in-flight withdrawal — their value is
        -- carried by the withdrawals join below (pending/processing count
        -- there). Matches calculateUsersPnlBatch so the pnl/inventoryValue/
        -- netHoldings sorts agree with the displayed (lock-excluded) values.
        WHERE sold_at IS NULL AND exchanged_at IS NULL AND withdrawal_locked_at IS NULL
          AND user_id IN (SELECT id FROM filtered)
        GROUP BY user_id
      ) inv ON inv.user_id = f.id
      LEFT JOIN (
        SELECT user_id, COALESCE(SUM(total_value_usd::numeric), 0) AS wd_value
        FROM card_withdrawal_requests
        -- In-flight (pending/processing) + done (shipped/completed) all count
        -- as a house withdrawal liability so the pnl sort stays continuous
        -- across the withdrawal lifecycle and matches the displayed
        -- totalWithdrawn from calculateUsersPnlBatch.
        WHERE status IN ('pending', 'processing', 'shipped', 'completed')
          AND user_id IN (SELECT id FROM filtered)
        GROUP BY user_id
      ) cw ON cw.user_id = f.id
      LEFT JOIN (
        SELECT user_id, COALESCE(SUM(value::numeric), 0) AS voucher_value
        FROM vouchers
        WHERE claimed_at IS NULL
          AND user_id IN (SELECT id FROM filtered)
        GROUP BY user_id
      ) vc ON vc.user_id = f.id
      -- FAKE-BALANCE: per-user SIGNED NET of completed official_stream
      -- adjustments, subtracted from the cash term of the balance-based
      -- sort expressions so the ordering matches the netted DISPLAYED
      -- availableBalance / netHoldings.
      LEFT JOIN (
        SELECT lt.user_id, COALESCE(SUM(lt.amount::numeric), 0) AS os_net
        FROM ledger_transactions lt
        WHERE lt.status = 'completed'
          AND ${officialStreamAdjustmentSqlPredicate({ typeColumn: "lt.type", metadataColumn: "lt.metadata" })}
          AND lt.user_id IN (SELECT id FROM filtered)
        GROUP BY lt.user_id
      ) os ON os.user_id = f.id${depositCountJoin}
      ORDER BY (${orderExpr}) ${orderSql} NULLS LAST, f.id ${orderSql}
      LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
    `),
    // Count the same filtered set. Only the WHERE clause matters for the
    // count, so the aggregate joins are dropped — this is a plain
    // index/seq count over `user` with the active predicate.
    db.$queryRawUnsafe<{ c: string }[]>(`
      SELECT COUNT(*)::text AS c FROM "user" u ${whereClause}
    `),
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
  ["users-ranked-ids-global-v2"],
  { revalidate: 300, tags: ["users-list"] },
);

const cachedFilteredRankedUserIds = unstable_cache(
  computeRankedUserIds,
  ["users-ranked-ids-filtered-v2"],
  { revalidate: 30, tags: ["users-list"] },
);

/**
 * Route a ranking request to the long-TTL global cache when no filter is
 * active, or the short-TTL filtered cache otherwise. A search term, role
 * filter, or status filter all count as "filtered".
 */
function cachedRankedUserIds(
  input: RankedUserIdsInput,
): Promise<{ ids: string[]; total: number }> {
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
  } = params;

  const where: Prisma.UserWhereInput = {};

  // Trim so stray leading/trailing whitespace (easy to paste in by
  // accident) doesn't turn a valid handle into a miss.
  const searchTerm = search?.trim();

  // ── Search fast paths ──────────────────────────────────────────────
  // The legacy code path ORed 4× ILIKE '%term%' across username /
  // display_username / name / email. ILIKE with a LEADING % can't use
  // ANY btree, so every keystroke triggered a full sequential scan of
  // the `user` table. On a ~7,800-row (and growing) prod table that's
  // the slow search admins were hitting.
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

  // Narrow projection — only the columns the list view actually renders.
  // The `user` table has 50+ columns; pulling them all back per page row
  // adds non-trivial bytes on every list query. Keep select in sync with
  // the fields read in the `data` mapping at the bottom of this file.
  const userSelect = {
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

  let users: Array<Prisma.UserGetPayload<{ select: typeof userSelect }>>;
  let total: number;

  if (RAW_SQL_SORTS.has(sortBy)) {
    // Heavy computed-sort path. The global ORDER BY scan (the source of
    // the "/users timed out" failure — most acutely the Top winners /
    // Top losers lifetime-PnL ranking) is delegated to the cached
    // ranking helper, which memoises the ordered ID slice + total for
    // this (sort / filter / page) tuple with a long TTL. Page row
    // HYDRATION stays here and stays UNCACHED so balances / PnL / risk
    // are always live; only the slow ordering is served from cache.
    const { ids, total: totalCount } = await cachedRankedUserIds({
      sortBy,
      order,
      page,
      perPage,
      searchTerm,
      isExactId,
      isEmailLike,
      isDiscordId,
      searchMode,
      role,
      status,
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

    if (isFreeFormTextSearch) {
      const filterInput: UserListFilterInput = {
        searchTerm,
        isExactId,
        isEmailLike,
        isDiscordId,
        searchMode,
        role,
        status,
      };
      const { ids, total: totalCount } = await cachedFilteredColumnSortUserIds(
        {
          ...filterInput,
          sortBy,
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
      const result = await Promise.all([
        db.user.findMany({
          where,
          orderBy,
          skip: (page - 1) * perPage,
          take: perPage,
          select: userSelect,
        }),
        db.user.count({ where }),
      ]);
      users = result[0];
      total = result[1];
    }
  }

  // Per-page aggregates are independent keyed on user_id and run in
  // parallel. The P&L components (inventory / card-withdrawals / vouchers
  // / balances) are bundled in calculateUsersPnlBatch so the canonical
  // formula lives in exactly one place. depositCount and riskScore stay
  // separate — they're used for other columns.
  const userIds = users.map((u) => u.id);
  const empty = {
    deposits: [] as Array<{ user_id: string; _count: { _all: number } }>,
  };
  // Skip the heavy list-level risk BATCH_SQL during free-form search —
  // finding the user fast matters more than per-row risk on the slice.
  const skipListRisk = isFreeFormTextSearch;
  const emptyRisk = new Map<
    string,
    {
      score: number;
      tier: RiskTier;
      sharedIpCount: number;
      sharedFingerprintCount: number;
    }
  >();
  const [pnlByUserId, depositCountRows, riskScoresMap] = await Promise.all([
    calculateUsersPnlBatch(userIds),
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
      : Promise.resolve(empty.deposits),
    userIds.length > 0 && !skipListRisk
      ? computeRiskScoresForList(userIds)
      : Promise.resolve(emptyRisk),
  ]);

  const depositCountMap = new Map(
    depositCountRows.map((d) => [d.user_id, d._count._all]),
  );

  return {
    data: users.map((u) => {
      const lockedBalance = toNumber(u.balances?.locked_balance);
      const totalWagered = toNumber(u.balances?.total_wagered);
      const userPnl = pnlByUserId.get(u.id);
      // FAKE-BALANCE: net the signed official_stream credit out of the
      // DISPLAYED available balance (and netHoldings) so the list matches
      // the P&L treatment AND the user-detail page. calculateUsersPnlBatch
      // already nets it from onSiteBalance, so derive available from there
      // (onSiteBalance = available + locked − officialStreamNet ⇒
      // available_netted = onSiteBalance − locked). No second query, can't
      // drift from the PnL column. Clamp ≥ 0 defensively. Falls back to the
      // raw available balance only when the batch row is missing.
      const availableBalance = userPnl
        ? Math.max(0, userPnl.onSiteBalance - lockedBalance)
        : toNumber(u.balances?.available_balance);
      const totalDeposited = userPnl?.deposits ?? 0;
      const totalWithdrawn = userPnl?.withdrawals ?? 0;
      const inventoryValue = userPnl?.inventoryValue ?? 0;
      const unclaimedVouchers = userPnl?.unclaimedVouchers ?? 0;
      // The data-table renders user-POV pnl (positive = user winning,
      // shown red because that's our liability). The shared helper returns
      // House-POV; flip the sign here to keep the column semantics intact.
      const pnl = userPnl ? -userPnl.pnl : 0;
      // Net on-platform holdings = cash (available + locked vault) +
      // open inventory + unclaimed vouchers. Vouchers are inventory
      // exactly like cards (cards + vouchers = inventory), so they're
      // part of what the user holds on-site. Uses the official_stream-netted
      // availableBalance above so the hidden fake balance never inflates net
      // holdings. (The SQL ORDER BY expression for the `netHoldings` sort
      // still uses raw balance for ordering only — see note below.)
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
