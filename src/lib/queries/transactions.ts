import { queryMainRows, queryRows } from "@/lib/drizzle-query";
import { unstable_cache } from "next/cache";
import { drizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import {
  ledger_transaction_type,
  ledger_transaction_status,
} from "@/lib/db-schema/main/schema";
import type { UserTagValue } from "@/lib/queries/user-tags";
import {
  fetchUpgraderTargetByLedgerTxIds,
  resolveUpgraderTargetFromBatch,
} from "./upgrader-target-batch";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  excludeStaffAndBlacklisted,
} from "./_blacklist";

// Allowlists derived from the generated Drizzle enums — used to validate
// user-supplied filter values before they reach the query (instead of an
// unchecked `as` cast). Object.values keeps them in sync with the schema
// automatically.
const LEDGER_TX_TYPES = new Set<string>(ledger_transaction_type.enumValues);
const LEDGER_TX_STATUSES = new Set<string>(
  ledger_transaction_status.enumValues,
);

export type TransactionListItem = {
  id: string;
  userId: string;
  username: string | null;
  image: string | null;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  status: string;
  description: string;
  createdAt: string;
  /**
   * USD value the user WON on a game-session row = card winnings
   * (sum of `provably_fair_results.user_inventory.value_at_obtained`)
   * PLUS the voucher excess that session spun off (battle/pack excess
   * parked as a `vouchers` row whose `origin_id` is the game_session
   * id). Honors the invariant inventory = cards + vouchers, so a row
   * surfaces the full value handed to the user, not just cards. Null on
   * non-game rows (deposit / withdrawal / manual adjustment). From the
   * house POV this value left the house → render rose.
   */
  payout: number | null;
  /**
   * Per-row house profit/loss in USD on a game-session row:
   * `housePnl = bet − payout` (what we took in vs cards+vouchers we paid
   * out). House POV: > 0 = house gain (emerald), < 0 = house loss
   * (rose). Null on non-game rows (no "—" math there). Replaces the old
   * meaningless `houseEdge` percentage which produced values like
   * -203900% on high-multiplier hits.
   */
  housePnl: number | null;
  cryptoAsset: string | null;
  cryptoAmount: number | null;
  // Set by mergeDepositBonuses() when a deposit_bonus ledger row has been
  // folded into its parent deposit row. Null means no merged bonus.
  bonusAmount: number | null;
  /**
   * % of the bet that the house fronted (borrow). null = not a
   * borrow-capable event (e.g. deposit, withdrawal). 0 = pack/battle
   * paid fully in cash. >0 = borrow signal — surfaced via BorrowBadge
   * across the transactions list, user-detail tab, and recent
   * activity feed.
   *
   * Source for solo pack opens: `provably_fair_results.result_metadata
   * ->>'borrow_percentage'` on the linked game_session.
   * Source for battle bets: the linked `battles.borrow_percentage`.
   */
  borrowPercentage: number | null;
  /**
   * USD value the house fronted on this row. For solo opens this is
   * the bet × borrow%. For battle bets it's the per-participant
   * fronted amount (bet × borrow%). Null when borrow doesn't apply.
   */
  borrowedAmountUsd: number | null;
  /**
   * Rolling 24h deposit total for THIS user (sum of completed deposits,
   * type='deposit', last 24h). Used by the Deposits transactions list
   * to show "user has deposited $X in the last 24h" next to the row's
   * amount. Null on non-deposit transaction lists (we don't populate
   * the field there since it isn't rendered).
   */
  userDeposit24h: number | null;
  /**
   * Rolling 3-day deposit total for THIS user. Same semantics as
   * userDeposit24h. Null when not rendered.
   */
  userDeposit3d: number | null;
  /**
   * Admin-set VIP tags on this user, fetched alongside the
   * deposits page so the row can show "Confirmed VIP" inline next
   * to the username. Empty array when not populated (other views),
   * empty array also when the user has no tags. Cross-DB lookup
   * against admin_user_tags.
   */
  userTags: UserTagValue[];
  /**
   * Game-session multiplier: `payout / bet`. Populated for pack-
   * opening + battle-bet rows (any row whose linked game_session
   * has card-value PF results). Null on rows where it doesn't apply
   * (deposits, withdrawals, manual adjustments). Used by the
   * "Highest Multiplier" sort filter on /transactions/packs.
   */
  multiplier: number | null;
  /**
   * Target cashout multiplier on an `upgrader_bet` row (e.g. 5 for
   * "5×") — what the user was rolling for, picked BEFORE the spin.
   * Parsed defensively from
   * `provably_fair_results.result_metadata` via
   * `parseUpgraderMetadata`. Null for every non-upgrader_bet row
   * and for upgrader rows where the backend didn't store the key
   * (the parser tries a handful of candidate field names — see
   * `lib/utils/upgrader-metadata.ts`). Surfaced in the shared
   * columns Type cell as a cyan "⇡ 5×" badge so admins reading the
   * ledger don't have to click through to learn what the user was
   * aiming at. Same parser + label as the /users/[id] Gaming tab
   * and the /transactions/upgrader detail popup (commit 5f22020),
   * so the surfaces never disagree.
   */
  upgraderTargetMultiplier: number | null;
};

/**
 * Paginated query specifically for the Deposits & Withdrawals view.
 *
 * Why a separate raw SQL query instead of reusing getTransactions + a
 * post-query merge: on the deposits view, each logical "deposit" may be
 * stored as two ledger rows (a `deposit` + a `deposit_bonus`). We want a
 * single merged row per logical deposit. Doing the merge AFTER a normal
 * `findMany` would return fewer rows per page than requested (because we'd
 * drop merged bonus rows after pagination). Doing it in SQL keeps the page
 * size exact and handles page-boundary edge cases correctly.
 *
 * Pairing rule (verified against real sample data — not guessed):
 *   - same user_id
 *   - bonus.balance_before exactly equals deposit.balance_after
 *   - bonus.created_at is within 2 minutes after deposit.created_at
 * The ledger is sequential per user and the bonus fires right after its
 * deposit with no intervening row, so balance continuity is a deterministic
 * link. Orphan `deposit_bonus` rows (e.g. manual admin bonus with no parent
 * deposit) are still returned as their own row.
 *
 * Filters supported: search (UUID or username), status.
 *
 * ── Caching ──────────────────────────────────────────────────────────
 * The public entry point is the `unstable_cache`-wrapped
 * {@link getDepositTransactions} below. This `compute*` does the actual
 * work and takes the resolved DB env as its first argument so it can
 * pick the right Drizzle client without reading
 * the request cookie via `cookies()` — illegal inside `unstable_cache`).
 * Resolving the env in the request scope and threading it through as a
 * cache-key dimension keeps the dev-DB toggle honest: a dev-toggled
 * admin's cache entry never collides with the prod one.
 */
async function computeDepositTransactions(
  env: DbEnv,
  blacklistKey: string,
  params: {
    page?: number;
    perPage?: number;
    search?: string;
    status?: string;
    /**
     * USD threshold — only return rows with `amount >= minAmount`. Used
     * by the Deposits page's "$200+" filter to surface big-ticket
     * deposits. Filters on the raw `t.amount` (deposit amount, before
     * the bonus merge) since that's the natural reading of "deposit
     * size". A $0 / falsy value disables the filter.
     */
    minAmount?: number;
  },
): Promise<PaginatedResult<TransactionListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    status,
    minAmount,
  } = params;
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * safePerPage;
  const blacklistIds = blacklistKey ? blacklistKey.split(",") : [];
  const userScopeFilter = `
    AND t.user_id IN (
      SELECT id
        FROM "user"
       WHERE role NOT IN ('admin', 'support')
         AND NOT (id = ANY($1::text[]))
    )
  `;

  // Bind user-provided values via positional parameters to avoid SQL injection.
  const queryParams: unknown[] = [blacklistIds];
  let searchFilter = "";
  // Username search needs the "user" join in the COUNT query too; a UUID
  // search (or no search) keeps COUNT as a bare index scan over deposits.
  let needsUserJoin = false;
  if (search) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        search
      );
    if (isUuid) {
      queryParams.push(search);
      const idx = queryParams.length;
      searchFilter = `AND (t.id::text = $${idx} OR t.user_id = $${idx})`;
    } else {
      queryParams.push(`%${search.toLowerCase()}%`);
      const idx = queryParams.length;
      searchFilter = `AND LOWER(u.username) LIKE $${idx}`;
      needsUserJoin = true;
    }
  }

  // Status is a whitelisted enum — safe to inline after validation.
  const VALID_STATUSES = new Set(["pending", "completed", "failed"]);
  const statusFilter =
    status && VALID_STATUSES.has(status)
      ? `AND t.status = '${status}'`
      : "";

  // Min-amount filter. Bind via positional parameter; coerce to a
  // safe finite non-negative number first so a NaN / negative URL
  // value can't smuggle SQL through. A 0 / undefined value disables.
  let minAmountFilter = "";
  if (typeof minAmount === "number" && Number.isFinite(minAmount) && minAmount > 0) {
    queryParams.push(minAmount);
    const idx = queryParams.length;
    minAmountFilter = `AND t.amount::numeric >= $${idx}`;
  }

  // Lean "Deposits" view — ONLY raw deposit rows. We no longer pull the
  // standalone deposit_bonus / shipping-fee rows or run the correlated
  // bonus-pair EXISTS exclusion; that scan across deposit + bonus +
  // shipping was what made this page crawl. Each deposit still gets its
  // paired bonus merged in via the LATERAL below — a per-page-row lookup,
  // not a whole-table scan.
  const baseWhere = `
    WHERE t.type::text = 'deposit'
      ${userScopeFilter}
      ${searchFilter}
      ${statusFilter}
      ${minAmountFilter}
  `;

  // Cheap count — a bare index scan over type='deposit' (no EXISTS).
  // Only joins "user" when the search filter is by username.
  const countSql = `
    SELECT COUNT(*)::text AS total
    FROM ledger_transactions t
    ${needsUserJoin ? `LEFT JOIN "user" u ON u.id = t.user_id` : ""}
    ${baseWhere}
  `;

  const dataSql = `
    SELECT
      t.id,
      t.user_id,
      u.username,
      u.image,
      t.type::text AS type,
      t.balance_before::text AS balance_before,
      t.balance_after::text AS balance_after,
      t.status::text AS status,
      t.description,
      t.created_at,
      t.crypto_asset,
      t.crypto_amount::text AS crypto_amount,
      b.amount::text AS bonus_amount,
      b.balance_after::text AS bonus_balance_after
    FROM ledger_transactions t
    LEFT JOIN "user" u ON u.id = t.user_id
    LEFT JOIN LATERAL (
      SELECT amount, balance_after
      FROM ledger_transactions
      WHERE user_id = t.user_id
        AND type::text = 'deposit_bonus'
        AND balance_before = t.balance_after
        AND created_at >= t.created_at
        AND created_at < t.created_at + INTERVAL '2 minutes'
      ORDER BY created_at ASC
      LIMIT 1
    ) b ON true
    ${baseWhere}
    ORDER BY t.created_at DESC
    LIMIT $${queryParams.length + 1}
    OFFSET $${queryParams.length + 2}
  `;

  type Raw = {
    id: string;
    user_id: string;
    username: string | null;
    image: string | null;
    type: string;
    balance_before: string;
    balance_after: string;
    status: string;
    description: string;
    created_at: Date;
    crypto_asset: string | null;
    crypto_amount: string | null;
    bonus_amount: string | null;
    bonus_balance_after: string | null;
  };

  const drizzleDb = drizzleForEnv(env);
  const [countResult, rows] = await Promise.all([
    queryRows<{ total: string }[]>(drizzleDb, countSql, ...queryParams),
    queryRows<Raw[]>(
      drizzleDb,
      dataSql,
      ...queryParams,
      safePerPage,
      offset,
    ),
  ]);

  const total = Number(countResult[0]?.total ?? "0");

  // NOTE: per-user 24h/3d deposit totals and VIP tags are intentionally
  // NOT preloaded here. They were the cross-DB / extra-aggregate round
  // trips that made this list slow. The page now ships only the raw
  // deposit rows; the totals/tags columns auto-hide when empty (see
  // columns.tsx conditionals) and can be loaded on demand per row.
  const data: TransactionListItem[] = rows.map((r) => {
    const balanceBefore = Number(r.balance_before);
    const rawBalanceAfter = Number(r.balance_after);
    const bonusAmount = r.bonus_amount != null ? Number(r.bonus_amount) : null;
    // When a bonus is attached, surface the post-bonus balance as the row's
    // final balance so the After column reflects the combined deposit+bonus.
    const finalBalanceAfter =
      bonusAmount != null && r.bonus_balance_after != null
        ? Number(r.bonus_balance_after)
        : rawBalanceAfter;
    return {
      id: r.id,
      userId: r.user_id,
      username: r.username,
      image: r.image,
      type: r.type,
      amount: finalBalanceAfter - balanceBefore,
      balanceBefore,
      balanceAfter: finalBalanceAfter,
      status: r.status,
      description: r.description,
      createdAt: r.created_at.toISOString(),
      // payout/housePnl are game-session metrics — not applicable here.
      payout: null,
      housePnl: null,
      cryptoAsset: r.crypto_asset,
      cryptoAmount: r.crypto_amount != null ? Number(r.crypto_amount) : null,
      bonusAmount,
      // Not preloaded — see note above. Columns auto-hide when null/empty.
      userDeposit24h: null,
      userDeposit3d: null,
      userTags: [],
      // Deposits/withdrawals can't be borrowed — null both fields so
      // the BorrowBadge cell renders empty.
      borrowPercentage: null,
      borrowedAmountUsd: null,
      // Multiplier is a game-session concept — doesn't apply to
      // deposit / withdrawal / shipping-fee rows.
      multiplier: null,
      // Upgrader target multiplier — only meaningful on upgrader_bet
      // rows, which this query never returns. Null keeps the type
      // contract consistent across views.
      upgraderTargetMultiplier: null,
    };
  });

  return {
    data,
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

/**
 * Cross-request cache layer for the Deposits tab list.
 *
 * Wraps {@link computeDepositTransactions} in a 300s `unstable_cache`
 * keyed on `(env, blacklistKey, {page, perPage, search, status,
 * minAmount})`. The arguments passed to a cached function participate in
 * its cache key, so each distinct filter/page combination gets its own
 * entry — switching back to a previously-viewed page is an instant cache
 * hit. The compute path seq-scans the ~855k-row ledger (the root fix is
 * an owner-only index, which MAIN's read-only / no-DDL policy forbids),
 * so a COLD miss is expensive (~15s). The 300s window widens warm-key
 * coverage — a distinct search term / minAmount stays warm five minutes
 * instead of one, so the next admin hitting the same filter pays the
 * cache hit, not the seq-scan. Mirrors the `unstable_cache` list pattern
 * in `users-list.ts`.
 *
 * Freshness is safe at 300s: deposits are NOT admin-mutated (the admin
 * never creates/edits a deposit ledger row), and NOTHING calls
 * `revalidateTag("transactions-deposits-list")` — the tag exists only
 * for a future manual bust. The page's 60s `AutoRefresh` simply re-runs
 * the segment, which re-reads the (now warm) cache; it does not require
 * the cache to expire on its cadence.
 *
 * `env` is the FIRST key dimension so a dev-DB-toggled admin's cache
 * entries never collide with the prod ones — behaviour is identical to
 * the uncached request-scoped path, just memoized.
 */
const cachedDepositTransactions = unstable_cache(
  computeDepositTransactions,
  ["transactions-deposits-list-v2"],
  { revalidate: 300, tags: ["transactions-deposits-list"] },
);

/**
 * Public entry point for the Deposits tab. Resolves the request's DB env
 * (cookie read happens HERE, in the request scope) then delegates to the
 * cached compute fn. See {@link computeDepositTransactions} for the
 * query itself.
 */
export async function getDepositTransactions(params: {
  page?: number;
  perPage?: number;
  search?: string;
  status?: string;
  minAmount?: number;
}): Promise<PaginatedResult<TransactionListItem>> {
  const env = await readDbEnv();
  const excluded = await getExcludedUserIds();
  const blacklistKey = [...excluded].sort().join(",");
  return cachedDepositTransactions(env, blacklistKey, params);
}

/**
 * Sort modes for the ledger transactions list.
 *   • recent           — newest first (default site-wide behaviour).
 *   • pack_multiplier  — pack-openings sorted by `payout / bet`
 *                        DESC. Forces `types = ['pack_opening']`
 *                        because multiplier is a game-session
 *                        concept; admins typically reach this from
 *                        /transactions/packs. Uses a SQL CTE pre-
 *                        cap (top 500 by multiplier) then loads
 *                        full rows for those IDs. Same pattern as
 *                        the /battles "Biggest Hit" sort.
 */
export type TransactionSortMode = "recent" | "pack_multiplier";

const PACK_MULTIPLIER_CAP = 500;

/**
 * Lifetime lookback cap (days) for the pack_multiplier sort CTE. Without
 * a bound, the CTE GROUP-BYs EVERY historical `pack_opening` row before
 * taking the top {@link PACK_MULTIPLIER_CAP} by multiplier — a full-table
 * aggregate scan that grows unbounded with ledger history. Bounding the
 * candidate window to the last year keeps the scan tractable while still
 * covering effectively all currently-relevant pack hits. Mirrors the
 * 365-day `LIFETIME_PAIRING_LOOKBACK_DAYS` precedent in the deposit-bonus
 * insights helpers.
 */
const PACK_MULTIPLIER_LOOKBACK_DAYS = 365;

type GetTransactionsParams = {
  page?: number;
  perPage?: number;
  search?: string;
  type?: string;
  types?: string[];
  status?: string;
  minAmount?: number;
  maxAmount?: number;
  sortBy?: TransactionSortMode;
};

/**
 * Does the actual list work. Takes the resolved DB env + user-scope
 * filter as its leading args so it never resolves request state /
 * `excludeStaffAndBlacklisted()` (both request-scoped: they read the
 * cookie / blacklist in the request) inside `unstable_cache`. Resolving
 * those in the request scope and threading them through keeps the dev-DB
 * toggle + blacklist honest as cache-key dimensions. Mirrors
 * {@link computeDepositTransactions}.
 */
async function computeTransactions(
  env: DbEnv,
  userScope: Awaited<ReturnType<typeof excludeStaffAndBlacklisted>>,
  params: GetTransactionsParams,
): Promise<PaginatedResult<TransactionListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    type,
    types,
    status,
    minAmount,
    maxAmount,
    sortBy = "recent",
  } = params;
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const safePage = Math.max(1, Math.floor(page));
  const rawDb = drizzleForEnv(env);
  const excludedIds =
    "id" in userScope && userScope.id && "notIn" in userScope.id
      ? [...userScope.id.notIn]
      : [];
  const binds: unknown[] = [excludedIds];
  const filters = [
    `u.role::text NOT IN ('admin', 'support')`,
    `NOT (u.id = ANY($1::text[]))`,
    `NOT (
      lt.type::text = 'admin_balance_adjustment'
      AND lt.metadata->>'adjustment_category' = 'official_stream'
    )`,
  ];

  if (search) {
    binds.push(search, `%${search.toLowerCase()}%`);
    const exact = `$${binds.length - 1}`;
    const fuzzy = `$${binds.length}`;
    filters.push(
      `(lt.id::text = ${exact} OR lt.user_id = ${exact}
        OR lt.metadata->>'battle_id' = ${exact}
        OR LOWER(u.username) LIKE ${fuzzy})`,
    );
  }

  const validTypes =
    types && types.length > 0
      ? types.filter((candidate) => LEDGER_TX_TYPES.has(candidate))
      : type && type !== "all" && LEDGER_TX_TYPES.has(type)
        ? [type]
        : [];
  if (validTypes.length > 0) {
    binds.push(validTypes);
    filters.push(`lt.type::text = ANY($${binds.length}::text[])`);
  }

  if (status && status !== "all" && LEDGER_TX_STATUSES.has(status)) {
    binds.push(status);
    filters.push(`lt.status::text = $${binds.length}`);
  }

  if (minAmount !== undefined && Number.isFinite(minAmount)) {
    binds.push(minAmount);
    filters.push(`lt.amount::numeric >= $${binds.length}`);
  }
  if (maxAmount !== undefined && Number.isFinite(maxAmount)) {
    binds.push(maxAmount);
    filters.push(`lt.amount::numeric <= $${binds.length}`);
  }
  const whereSql = filters.join("\n AND ");

  type TransactionRecord = {
    id: string;
    user_id: string;
    type: string;
    balance_before: string;
    balance_after: string;
    status: string;
    description: string;
    created_at: Date;
    crypto_asset: string | null;
    crypto_amount: string | null;
    user: { username: string | null; image: string | null } | null;
    game_sessions_ledger_transactions_game_session_idTogame_sessions: {
      id: string;
      bet_amount: string;
      provably_fair_results: {
        battle_id: string | null;
        result_metadata: unknown;
        user_inventory: { value_at_obtained: string } | null;
      }[];
    } | null;
  };
  let transactions: TransactionRecord[];
  let total: number;
  const selectSql = `
    SELECT lt.id, lt.user_id, lt.type::text AS type,
           lt.balance_before::text, lt.balance_after::text,
           lt.status::text AS status, lt.description, lt.created_at,
           lt.crypto_asset, lt.crypto_amount::text,
           jsonb_build_object('username', u.username, 'image', u.image) AS "user",
           CASE WHEN gs.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', gs.id,
             'bet_amount', gs.bet_amount::text,
             'provably_fair_results', COALESCE(pf.rows, '[]'::jsonb)
           ) END AS game_sessions_ledger_transactions_game_session_idTogame_sessions
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      LEFT JOIN game_sessions gs ON gs.id = lt.game_session_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'battle_id', pfr.battle_id,
            'result_metadata', pfr.result_metadata,
            'user_inventory', CASE WHEN ui.id IS NULL THEN NULL ELSE
              jsonb_build_object('value_at_obtained', ui.value_at_obtained::text)
            END
          )
          ORDER BY pfr.cursor ASC
        ) AS rows
          FROM provably_fair_results pfr
          LEFT JOIN user_inventory ui ON ui.id = pfr.inventory_item_id
         WHERE pfr.game_session_id = gs.id
      ) pf ON TRUE
  `;

  if (sortBy === "pack_multiplier") {
    // SQL CTE pre-cap by computed multiplier (payout / bet). Same
    // pattern as /battles "Biggest Hit": compute the metric in SQL,
    // pull the top N IDs, then load the full rows. Without this,
    // sorting by a derived field would require pulling every
    // pack_opening row into memory.
    //
    // bet     = lt.amount (positive — debits are stored absolute in
    //           this DB; the sign lives in balance_after-before).
    // payout  = SUM(user_inventory.value_at_obtained) for the PF
    //           results on the linked game_session. Cards sold/
    //           exchanged BEFORE the snapshot still show up because
    //           the user_inventory row stays — its sold_at/
    //           exchanged_at columns are timestamps, not deletes.
    //
    // The CTE deliberately ignores status filter / search / minAmount
    // — those are applied in the secondary findMany so combining
    // them with the multiplier sort still narrows the result set
    // honestly (potentially fewer than perPage rows on a narrow
    // search, which is fine for the "find the biggest hit matching X"
    // use case).
    const topRows = await queryRows<{ id: string }[]>(
      rawDb,
      `
      WITH pack_multipliers AS (
        SELECT
          lt.id,
          lt.amount::numeric AS bet,
          COALESCE(SUM(COALESCE(ui.value_at_obtained::numeric, 0)), 0) AS payout
        FROM ledger_transactions lt
        LEFT JOIN game_sessions gs ON gs.id = lt.game_session_id AND gs.game_type = 'pack'
        LEFT JOIN provably_fair_results pf ON pf.game_session_id = gs.id
        LEFT JOIN user_inventory ui ON ui.id = pf.inventory_item_id
        WHERE lt.type::text = 'pack_opening'
          AND lt.status = 'completed'
          AND lt.amount::numeric > 0
          AND lt.created_at >= NOW() - make_interval(days => $1::int)
        GROUP BY lt.id, lt.amount
      )
      SELECT id::text AS id
      FROM pack_multipliers
      WHERE payout > 0
      ORDER BY (payout / bet) DESC NULLS LAST
      LIMIT $2
      `,
      PACK_MULTIPLIER_LOOKBACK_DAYS,
      PACK_MULTIPLIER_CAP,
    );
    const topIds = topRows.map((r) => r.id);

    if (topIds.length === 0) {
      transactions = [];
      total = 0;
    } else {
      const idsIndex = binds.length + 1;
      const limitIndex = binds.length + 2;
      const offsetIndex = binds.length + 3;
      const scopedWhere = `${whereSql}
        AND lt.id = ANY($${idsIndex}::uuid[])`;
      const [rows, counts] = await Promise.all([
        queryRows<TransactionRecord[]>(
          rawDb,
          `${selectSql}
           WHERE ${scopedWhere}
           ORDER BY array_position($${idsIndex}::uuid[], lt.id)
           LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
          ...binds,
          topIds,
          safePerPage,
          (safePage - 1) * safePerPage,
        ),
        queryRows<{ total: string }[]>(
          rawDb,
          `SELECT COUNT(*)::text AS total
             FROM ledger_transactions lt
             JOIN "user" u ON u.id = lt.user_id
            WHERE ${scopedWhere}`,
          ...binds,
          topIds,
        ),
      ]);
      transactions = rows;
      total = Number(counts[0]?.total ?? 0);
    }
  } else {
    const limitIndex = binds.length + 1;
    const offsetIndex = binds.length + 2;
    const [rows, counts] = await Promise.all([
      queryRows<TransactionRecord[]>(
        rawDb,
        `${selectSql}
         WHERE ${whereSql}
         ORDER BY lt.created_at DESC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        ...binds,
        safePerPage,
        (safePage - 1) * safePerPage,
      ),
      queryRows<{ total: string }[]>(
        rawDb,
        `SELECT COUNT(*)::text AS total
           FROM ledger_transactions lt
           JOIN "user" u ON u.id = lt.user_id
          WHERE ${whereSql}`,
        ...binds,
      ),
    ]);
    transactions = rows;
    total = Number(counts[0]?.total ?? 0);
  }

  // Battle borrow lookup — for any battle_bet / battle_sponsorship row
  // that has a linked PF result with a battle_id, we need the
  // battles.borrow_percentage to render the badge. One round-trip
  // batched across the visible page; cheaper than fanning out
  // out a per-row include.
  //
  // CRITICAL: this lookup is AUXILIARY — the page's whole job is to
  // show the ledger, and the borrow badge is a nice-to-have on top.
  // If this single round-trip fails (DB blip, schema drift on the
  // battles table, replica lag, anything), the WHOLE /transactions
  // page used to crash — admin sees the route-level error boundary
  // ("Couldn't load the ledger") instead of the rows. Wrap in
  // try/catch and degrade gracefully: rows still render, badge is
  // just absent for that page-load. Logged so we still notice in
  // Vercel function logs.
  const battleIds = new Set<string>();
  for (const t of transactions) {
    const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
    for (const pf of gs?.provably_fair_results ?? []) {
      if (pf.battle_id) battleIds.add(pf.battle_id);
    }
  }
  const battleBorrowMap = new Map<string, number>();
  if (battleIds.size > 0) {
    try {
      const battles = await queryRows<
        { id: string; borrow_percentage: number | null }[]
      >(
        rawDb,
        `SELECT id, borrow_percentage
           FROM battles WHERE id = ANY($1::uuid[])`,
        [...battleIds],
      );
      for (const b of battles) {
        battleBorrowMap.set(b.id, b.borrow_percentage ?? 0);
      }
    } catch (e) {
      console.error(
        "[getTransactions] battle borrow lookup failed (non-fatal — rows still render without badge):",
        e,
      );
    }
  }

  // Per-session voucher excess — mirrors getUserTransactions'
  // `voucherValueByGameSession`. Battle / pack excess gets parked as a
  // `vouchers` row whose `origin_id` is the originating game_session id.
  // That value is part of what the user WON (invariant: inventory =
  // cards + vouchers), so it has to be added to `payout` alongside the
  // card value — otherwise a high-multiplier hit that paid out mostly as
  // a voucher reads as a tiny loss. Batched across the page's session
  // ids in one round-trip (no N+1).
  //
  // Auxiliary lookup — same graceful-degrade convention as the borrow
  // map above: a failure must not crash the whole /transactions page.
  const sessionIds = new Set<string>();
  for (const t of transactions) {
    const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
    if (gs?.id) sessionIds.add(gs.id);
  }
  const voucherValueBySession = new Map<string, number>();
  if (sessionIds.size > 0) {
    try {
      const vouchers = await queryRows<
        { origin_id: string | null; value: string }[]
      >(
        rawDb,
        `SELECT origin_id, value::text
           FROM vouchers WHERE origin_id = ANY($1::uuid[])`,
        [...sessionIds],
      );
      for (const v of vouchers) {
        if (!v.origin_id) continue;
        voucherValueBySession.set(
          v.origin_id,
          (voucherValueBySession.get(v.origin_id) ?? 0) + toNumber(v.value),
        );
      }
    } catch (e) {
      console.error(
        "[getTransactions] voucher excess lookup failed (non-fatal — payout falls back to card value only):",
        e,
      );
    }
  }

  const upgraderBetLedgerIds = transactions
    .filter((t) => t.type === "upgrader_bet")
    .map((t) => t.id);
  const upgraderTargetByLedgerId = await fetchUpgraderTargetByLedgerTxIds(
    upgraderBetLedgerIds,
  );

  return {
    data: transactions.map((t) => {
      const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
      let housePnl: number | null = null;
      let payout: number | null = null;
      let borrowPercentage: number | null = null;
      let borrowedAmountUsd: number | null = null;
      let multiplier: number | null = null;
      // Target cashout multiplier on upgrader_bet rows — parsed
      // defensively from the first PF result's result_metadata via
      // the shared parser. Same source the per-user Gaming tab and
      // the upgrader detail popup use, so the surfaces stay aligned.
      // Null for every non-upgrader row and for any upgrader row
      // whose backend didn't store one of the recognized keys.
      let upgraderTargetMultiplier: number | null = null;
      if (gs) {
        const cost = toNumber(gs.bet_amount);
        // Card winnings from the session's PF results...
        const cardValue = gs.provably_fair_results.reduce(
          (sum, pf) => sum + (pf.user_inventory ? toNumber(pf.user_inventory.value_at_obtained) : 0),
          0
        );
        // ...plus the voucher excess this session spun off. Together
        // they're the full value the user won (cards + vouchers),
        // honoring the inventory invariant.
        const voucherExcess = voucherValueBySession.get(gs.id) ?? 0;
        payout = cardValue + voucherExcess;
        // Per-row HOUSE P&L in USD: bet taken in minus value paid out
        // (cards + vouchers). House POV: >0 = house gain (emerald),
        // <0 = house loss (rose). Replaces the old houseEdge %.
        housePnl = cost - payout;
        if (cost > 0) {
          // `payout / bet` — total value the user got back (cards +
          // vouchers) vs what they paid in for this game session. >1
          // means they hit. Surfaced on the packs transactions page for
          // the "Highest Multiplier" sort.
          multiplier = payout / cost;
        }
        // Borrow %: pull from the linked battle for battle rows, else
        // from the first PF result's metadata for solo opens. All PF
        // results in one solo session share the same borrow setting,
        // so reading the first is correct.
        const firstPf = gs.provably_fair_results[0];
        if (firstPf?.battle_id) {
          borrowPercentage = battleBorrowMap.get(firstPf.battle_id) ?? null;
        } else if (firstPf) {
          const meta = firstPf.result_metadata as Record<string, unknown> | null;
          const raw = meta?.borrow_percentage;
          if (typeof raw === "number") borrowPercentage = raw;
          else if (typeof raw === "string") {
            const n = parseInt(raw, 10);
            borrowPercentage = Number.isFinite(n) ? n : null;
          }
        }
        if (borrowPercentage != null && borrowPercentage > 0 && cost > 0) {
          borrowedAmountUsd = cost * (borrowPercentage / 100);
        }
        // Upgrader target multiplier — reuse `firstPf` which was
        // already pulled for the borrow lookup, so no extra walk
        // of the PF results array. parseUpgraderMetadata is safe
        // on any value (returns null fields for non-objects), and
        // we only assign for upgrader_bet rows so other types
        // don't accidentally pick up a multiplier from a
        // non-upgrader PF blob.
        if (t.type === "upgrader_bet") {
          const resolved = resolveUpgraderTargetFromBatch(
            upgraderTargetByLedgerId.get(t.id),
            ...gs.provably_fair_results.map((pf) => pf.result_metadata),
          );
          upgraderTargetMultiplier = resolved.targetMultiplier;
        }
      } else if (t.type === "upgrader_bet") {
        const resolved = resolveUpgraderTargetFromBatch(
          upgraderTargetByLedgerId.get(t.id),
        );
        upgraderTargetMultiplier = resolved.targetMultiplier;
      }
      const balanceBefore = toNumber(t.balance_before);
      const balanceAfter = toNumber(t.balance_after);
      return {
        id: t.id,
        userId: t.user_id,
        username: t.user?.username ?? null,
        image: t.user?.image ?? null,
        type: t.type,
        amount: balanceAfter - balanceBefore,
        balanceBefore,
        balanceAfter,
        status: t.status,
        description: t.description,
        createdAt: t.created_at.toISOString(),
        payout,
        housePnl,
        cryptoAsset: t.crypto_asset,
        cryptoAmount: t.crypto_amount ? toNumber(t.crypto_amount) : null,
        // Shared query doesn't pair deposit_bonus rows — only the
        // deposits-specific getDepositTransactions does that merging.
        bonusAmount: null,
        borrowPercentage,
        borrowedAmountUsd,
        // Per-user deposit totals are only populated by
        // getDepositTransactions where the 24h/3d cells render. Null
        // here so the type contract stays consistent across views.
        userDeposit24h: null,
        userDeposit3d: null,
        // Tags only fetched on the deposits-specific path.
        userTags: [],
        multiplier,
        upgraderTargetMultiplier,
      };
    }),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

/**
 * Cross-request cache for the shared transactions list — covers BOTH the
 * `recent` and `pack_multiplier` sort paths, and every consumer of
 * {@link getTransactions} (the Rewards tab, the Packs transactions tab,
 * …). Wraps {@link computeTransactions} in a 300s `unstable_cache` keyed
 * on `(env, userScope, params)`. The `params` object carries every filter
 * dimension (search, type, types, status, minAmount, maxAmount, sortBy,
 * page, perPage), so each distinct filter/page/sort combination — incl.
 * the per-request search term — gets its own entry rather than colliding.
 * `env` + `userScope` lead the key so a dev-DB-toggled admin and a changed
 * blacklist never read a stale entry. Mirrors the
 * `cachedDepositTransactions` 300s window above.
 *
 * Freshness at 300s is safe: ledger rows are NOT admin-mutated (the admin
 * never creates/edits a ledger row), and the page's `AutoRefresh` simply
 * re-runs the segment against the warm cache. The tag exists for a future
 * manual bust.
 */
const cachedTransactions = unstable_cache(
  computeTransactions,
  ["transactions-list-v1"],
  { revalidate: 300, tags: ["transactions-list"] },
);

/**
 * Public entry point for the shared transactions list. Resolves the
 * request's DB env + staff/blacklist user-scope (cookie + blacklist reads
 * happen HERE, in the request scope) then delegates to the cached compute
 * fn. See {@link computeTransactions} for the query itself.
 */
export async function getTransactions(
  params: GetTransactionsParams,
): Promise<PaginatedResult<TransactionListItem>> {
  const env = await readDbEnv();
  const userScope = await excludeStaffAndBlacklisted();
  return cachedTransactions(env, userScope, params);
}

/**
 * Actual transaction-detail read (~10+ Main-DB round-trips: the ledger row,
 * the game session + its PF results, packs / battle packs, related ledger
 * rows, session vouchers, upgrader won-amount + inventory, cards, and the
 * battle password-existence check). Several of those legs currently
 * seq-scan on prod (related ledger rows by `game_session_id`, session
 * vouchers by `origin_id`, the upgrader `bet_ledger_tx_id` lookup — see the
 * recommended-index flags in prisma/recommended-indexes.sql), so the read
 * is genuinely heavy. The cached + safeQuery-wrapped public entry point is
 * {@link getTransactionDetail} below; this `compute*` does the real work.
 */
async function computeTransactionDetail(id: string) {
  const [tx] = await queryMainRows<
    {
      id: string;
      user_id: string;
      username: string | null;
      email: string | null;
      type: string;
      balance_before: string;
      balance_after: string;
      game_session_id: string | null;
      crypto_asset: string | null;
      crypto_amount: string | null;
      exchange_rate: string | null;
      blockchain_tx_hash: string | null;
      source_address: string | null;
      destination_address: string | null;
      status: string;
      failure_reason: string | null;
      description: string;
      metadata: unknown;
      created_at: Date;
      updated_at: Date;
    }[]
  >(
    `
      SELECT lt.id, lt.user_id, u.username, u.email, lt.type::text AS type,
             lt.balance_before::text, lt.balance_after::text,
             lt.game_session_id, lt.crypto_asset,
             lt.crypto_amount::text, lt.exchange_rate::text,
             lt.blockchain_tx_hash, lt.source_address, lt.destination_address,
             lt.status::text AS status, lt.failure_reason, lt.description,
             lt.metadata, lt.created_at, lt.updated_at
        FROM ledger_transactions lt
        LEFT JOIN "user" u ON u.id = lt.user_id
       WHERE lt.id = $1::uuid
       LIMIT 1
    `,
    id,
  );

  if (!tx) return null;

  const balanceBefore = toNumber(tx.balance_before);
  const balanceAfter = toNumber(tx.balance_after);
  // Derive the actual signed amount from balance change
  const amount = balanceAfter - balanceBefore;

  // If this tx is linked to a game session, fetch cards obtained
  let gameSession: {
    gameType: string;
    betAmount: number;
    houseEdge: number | null;
    /**
     * Total card value handed to the user on this session (sum of
     * value_at_obtained across obtained cards). House loss.
     */
    cardsValue: number;
    /**
     * Voucher excess this session spun off (battle/pack excess parked
     * as a voucher whose origin_id is this game_session id). Part of
     * what the user won. House loss.
     */
    voucherValue: number;
    /**
     * Full value the user won = cardsValue + voucherValue (invariant
     * inventory = cards + vouchers). House loss → rose.
     */
    itemsWon: number;
    /**
     * House P&L on this session in USD = betAmount − itemsWon. >0 =
     * house gain (emerald), <0 = house loss (rose).
     */
    housePnl: number;
    packs: { name: string; imageUrl: string | null; priceUsd: number; quantity: number }[];
    cardsObtained: {
      name: string;
      imageUrl: string | null;
      rarity: string | null;
      valueAtObtained: number;
      currentPriceUsd: number;
    }[];
    relatedTransactions: {
      id: string;
      type: string;
      amount: number;
      description: string;
    }[];
    /**
     * Provably-fair roll record for each tick of this session — one
     * row per pack-card / per upgrader spin / per battle PF result.
     * Carries the ticket number the server rolled (the "ticket they
     * hit"), the PF proof material (client seed, server seed +
     * pre-image hash, nonce, cursor, result hash), the raw
     * result_metadata blob the backend writes per game type, plus the
     * linked card (so admins can see "ticket 4732 → won this card")
     * when an inventory item is attached.
     */
    pfResults: {
      id: string;
      clientSeed: string;
      serverSeedHash: string;
      serverSeed: string | null;
      nonce: number;
      cursor: number;
      ticket: number;
      resultHash: string;
      resultMetadata: unknown;
      card: {
        name: string;
        imageUrl: string | null;
        rarity: string | null;
        valueAtObtained: number;
      } | null;
    }[];
  } | null = null;

  // Upgrader bets link the canonical session via
  // `game_sessions.bet_ledger_tx_id` — ledger.game_session_id can be
  // null or point at a stale row. Prefer the bet_ledger_tx_id match.
  let resolvedSessionId = tx.game_session_id;
  if (tx.type === "upgrader_bet") {
    const [canonical] = await queryMainRows<{ id: string }[]>(
      `SELECT id FROM game_sessions
        WHERE bet_ledger_tx_id = $1::uuid AND game_type::text = 'upgrader'
        ORDER BY created_at DESC LIMIT 1`,
      tx.id,
    );
    if (canonical) resolvedSessionId = canonical.id;
    else if (!resolvedSessionId) {
      const [fallback] = await queryMainRows<{ id: string }[]>(
        `SELECT id FROM game_sessions
          WHERE bet_ledger_tx_id = $1::uuid
          ORDER BY created_at DESC LIMIT 1`,
        tx.id,
      );
      resolvedSessionId = fallback?.id ?? null;
    }
  }

  if (resolvedSessionId) {
    // Narrow `provably_fair_results` columns to just what downstream uses.
    // The PF table is wide (client_seed, server_seed, server_seed_hash,
    // result_hash, ticket, result_metadata, etc.) but on this page we only
    // join through it to grab the linked inventory item.
    const [sessionRows, pfRows] = await Promise.all([
      queryMainRows<
        { game_type: string; game_id: string | null; bet_amount: string }[]
      >(
        `SELECT game_type::text AS game_type, game_id, bet_amount::text
           FROM game_sessions WHERE id = $1::uuid LIMIT 1`,
        resolvedSessionId,
      ),
      queryMainRows<
        {
          id: string;
          client_seed: string;
          server_seed_hash: string;
          server_seed: string | null;
          nonce: number;
          cursor: number;
          ticket: number;
          result_hash: string;
          result_metadata: unknown;
          battle_id: string | null;
          card_id: string | null;
          value_at_obtained: string | null;
        }[]
      >(
        `SELECT pf.id, pf.client_seed, pf.server_seed_hash, pf.server_seed,
                pf.nonce, pf.cursor, pf.ticket, pf.result_hash,
                pf.result_metadata, pf.battle_id, ui.card_id,
                ui.value_at_obtained::text
           FROM provably_fair_results pf
           LEFT JOIN user_inventory ui ON ui.id = pf.inventory_item_id
          WHERE pf.game_session_id = $1::uuid
          ORDER BY pf.cursor ASC`,
        resolvedSessionId,
      ),
    ]);
    const baseSession = sessionRows[0];
    const session = baseSession
      ? {
          ...baseSession,
          provably_fair_results: pfRows.map((pf) => ({
            ...pf,
            user_inventory:
              pf.card_id && pf.value_at_obtained != null
                ? {
                    card_id: pf.card_id,
                    value_at_obtained: pf.value_at_obtained,
                  }
                : null,
          })),
        }
      : null;

    if (session) {
      // Fetch pack info based on game type, card details, and related
      // transactions in parallel — they're independent.
      let packs: { name: string; imageUrl: string | null; priceUsd: number; quantity: number }[] = [];

      const cardIds = session.provably_fair_results
        .map((pf) => pf.user_inventory?.card_id)
        .filter((cid): cid is string => !!cid);

      const packsPromise =
        session.game_type === "pack"
          ? queryMainRows<
              {
                name: string;
                image_url: string | null;
                price: string;
                cards_per_open: number;
              }[]
            >(
              `SELECT name, image_url, price::text, cards_per_open
                 FROM packs WHERE id = $1::uuid LIMIT 1`,
              session.game_id,
            ).then(([pack]) => {
                if (!pack) return [];
                const cardsCount = session.provably_fair_results.length;
                const packsOpened =
                  pack.cards_per_open > 0 ? Math.round(cardsCount / pack.cards_per_open) : 1;
                return [
                  {
                    name: pack.name,
                    imageUrl: pack.image_url,
                    priceUsd: toNumber(pack.price),
                    quantity: packsOpened,
                  },
                ];
              })
          : session.game_type === "battle"
          ? queryMainRows<{ pack_ids: string[] }[]>(
              `SELECT pack_ids FROM battles WHERE id = $1::uuid LIMIT 1`,
              session.game_id,
            ).then(async ([battle]) => {
                if (!battle || battle.pack_ids.length === 0) return [];
                const battlePacks = await queryMainRows<
                  { name: string; image_url: string | null; price: string }[]
                >(
                  `SELECT name, image_url, price::text
                     FROM packs WHERE id = ANY($1::uuid[])`,
                  battle.pack_ids,
                );
                return battlePacks.map((p) => ({
                  name: p.name,
                  imageUrl: p.image_url,
                  priceUsd: toNumber(p.price),
                  quantity: 1,
                }));
              })
          : Promise.resolve([] as { name: string; imageUrl: string | null; priceUsd: number; quantity: number }[]);

      const relatedTxsPromise = queryMainRows<
        {
          id: string;
          type: string;
          balance_before: string;
          balance_after: string;
          description: string;
        }[]
      >(
        `SELECT id, type::text AS type, balance_before::text,
                balance_after::text, description
           FROM ledger_transactions
          WHERE game_session_id = $1::uuid
          ORDER BY created_at ASC`,
        resolvedSessionId,
      );

      // Voucher excess this session spun off — parked as a `vouchers`
      // row whose origin_id is the game_session id. Part of what the
      // user won (invariant inventory = cards + vouchers), so it's
      // surfaced alongside the cards on the detail page.
      const vouchersPromise = queryMainRows<{ value: string }[]>(
        `SELECT value::text FROM vouchers WHERE origin_id = $1::uuid`,
        resolvedSessionId,
      );

      // Upgrader-only data path. Pack and battle sessions get
      // `provably_fair_results.user_inventory` populated by the
      // backend, so the PF→inventory chain above already carries the
      // won card + value. Upgrader sessions don't reliably emit that
      // link — the service credits wins straight to the user's
      // balance and writes the inventory row directly with
      // source_type='upgrader', so reading off PF alone underreads
      // wonValue to $0 and misses the card entirely (the symptom on
      // the popup: "win" badge with `Won = —` and no card chip).
      //
      // We fix that here by:
      //   1. Pulling the canonical `won_amount` straight off
      //      `upgrader_games`.
      //   2. Finding the won card via `user_inventory` with
      //      source_type='upgrader' and source_id matching either
      //      game_sessions.id or upgrader_games.id (backend convention
      //      is uncertain, so we accept either defensively).
      // Wrapped in a single conditional so non-upgrader sessions skip
      // both queries entirely.
      const isUpgrader =
        session.game_type === "upgrader" && !!session.game_id;
      const upgraderWonPromise = isUpgrader
        ? queryMainRows<{ won_amount: string }[]>(
            `
              SELECT won_amount::text AS won_amount
                FROM upgrader_games
               WHERE id = $1::uuid
            `,
            session.game_id,
          )
        : Promise.resolve([] as { won_amount: string }[]);
      const upgraderInventoryPromise = isUpgrader
        ? queryMainRows<
            { id: string; card_id: string; value_at_obtained: string }[]
          >(
            `SELECT id, card_id, value_at_obtained::text
               FROM user_inventory
              WHERE user_id = $1
                AND source_type::text = 'upgrader'
                AND source_id = ANY($2::uuid[])
              ORDER BY obtained_at ASC`,
            tx.user_id,
            [resolvedSessionId, session.game_id],
          )
        : Promise.resolve(
            [] as Array<{
              id: string;
              card_id: string;
              value_at_obtained: string;
            }>,
          );

      // Wave 2 — packs / related / vouchers / upgrader queries run in
      // parallel. Cards moves into wave 3 below because we don't know
      // the full set of card IDs (PF-linked + upgrader-inventory
      // linked) until upgraderInventory resolves.
      const [
        packsResolved,
        relatedTxs,
        sessionVouchers,
        upgraderWonRows,
        upgraderInventoryItems,
      ] = await Promise.all([
        packsPromise,
        relatedTxsPromise,
        vouchersPromise,
        upgraderWonPromise,
        upgraderInventoryPromise,
      ]);
      packs = packsResolved;

      // Wave 3 — one cards fetch covering every id either source
      // produced. De-duped so a card that happens to appear in both
      // (defensive — shouldn't happen) only fires once.
      const allCardIds = Array.from(
        new Set([
          ...cardIds,
          ...upgraderInventoryItems.map((i) => i.card_id),
        ]),
      );
      const cards =
        allCardIds.length > 0
          ? await queryMainRows<
              {
                id: string;
                name: string;
                image_url: string | null;
                rarity: string | null;
                price: string;
              }[]
            >(
              `SELECT id, name, image_url, rarity::text, price::text
                 FROM cards WHERE id = ANY($1::uuid[])`,
              allCardIds,
            )
          : ([] as Array<{
              id: string;
              name: string;
              image_url: string | null;
              rarity: string | null;
              price: unknown;
            }>);

      const cardsMap = new Map(cards.map((c) => [c.id, c]));

      const betAmount = toNumber(session.bet_amount);
      // Canonical upgrader payout — overrides the PF-derived value.
      // Null when no row matched (defensive); pack/battle path keeps
      // the original cardsValue derivation.
      const upgraderWonAmount =
        upgraderWonRows[0]?.won_amount != null
          ? toNumber(upgraderWonRows[0].won_amount)
          : null;
      // For upgrader, cardsValue IS the upgrader_games.won_amount —
      // sum of items the user actually took home. For pack/battle,
      // keep the PF-derived cardsValue.
      const cardsValue =
        upgraderWonAmount != null
          ? upgraderWonAmount
          : session.provably_fair_results
              .filter(
                (pf) =>
                  pf.user_inventory?.card_id &&
                  cardsMap.has(pf.user_inventory.card_id),
              )
              .reduce(
                (sum, pf) => sum + toNumber(pf.user_inventory!.value_at_obtained),
                0,
              );
      const voucherValue = sessionVouchers.reduce(
        (sum, v) => sum + toNumber(v.value),
        0,
      );
      // Full value won = cards + voucher excess; house P&L = bet − that.
      const itemsWon = cardsValue + voucherValue;
      const housePnl = betAmount - itemsWon;
      const houseEdge = betAmount > 0 ? (housePnl / betAmount) * 100 : null;

      // cardsObtained = the cards the user took home.
      //   • Pack / battle → derive from PF.user_inventory (the
      //     existing reliable chain).
      //   • Upgrader      → derive from the direct user_inventory
      //     query above, since PF.user_inventory may be empty.
      const cardsObtained =
        upgraderInventoryItems.length > 0
          ? upgraderInventoryItems
              .filter((inv) => cardsMap.has(inv.card_id))
              .map((inv) => {
                const card = cardsMap.get(inv.card_id)!;
                return {
                  name: card.name,
                  imageUrl: card.image_url,
                  rarity: card.rarity,
                  valueAtObtained: toNumber(inv.value_at_obtained),
                  currentPriceUsd: toNumber(card.price),
                };
              })
          : session.provably_fair_results
              .filter(
                (pf) =>
                  pf.user_inventory?.card_id &&
                  cardsMap.has(pf.user_inventory.card_id),
              )
              .map((pf) => {
                const card = cardsMap.get(pf.user_inventory!.card_id)!;
                return {
                  name: card.name,
                  imageUrl: card.image_url,
                  rarity: card.rarity,
                  valueAtObtained: toNumber(pf.user_inventory!.value_at_obtained),
                  currentPriceUsd: toNumber(card.price),
                };
              });

      gameSession = {
        gameType: session.game_type,
        betAmount,
        houseEdge,
        cardsValue,
        voucherValue,
        itemsWon,
        housePnl,
        packs,
        cardsObtained,
        relatedTransactions: relatedTxs.map((rt) => ({
          id: rt.id,
          type: rt.type,
          amount: toNumber(rt.balance_after) - toNumber(rt.balance_before),
          description: rt.description,
        })),
        // Per-roll PF record. For pack opens this is one row per
        // card; for upgrader it's the single spin (ticket =
        // roll-result that decided whether the upgrade hit); for
        // battles it's one row per draw inside the user's session.
        // Card data is joined where the PF row links to an inventory
        // item (the "ticket → card" pairing admins want on wins).
        //
        // For upgrader the PF→inventory FK isn't reliably written, so
        // we fall back to pairing each PF roll with its same-index
        // entry from the direct upgrader user_inventory query above
        // (both are ordered by cursor / obtained_at ASC, so a roll's
        // card lines up positionally). One spin → one item is the
        // typical upgrader shape; the pairing degrades gracefully when
        // arrays differ in length.
        pfResults: session.provably_fair_results.map((pf, idx) => {
          // 1. Preferred: the FK on the PF row.
          let cardId: string | null = pf.user_inventory?.card_id ?? null;
          let valueAtObtained: number | null = pf.user_inventory
            ? toNumber(pf.user_inventory.value_at_obtained)
            : null;
          // 2. Fallback for upgrader: same-index entry from the
          //    direct user_inventory lookup.
          if (!cardId && upgraderInventoryItems[idx]) {
            cardId = upgraderInventoryItems[idx].card_id;
            valueAtObtained = toNumber(
              upgraderInventoryItems[idx].value_at_obtained,
            );
          }
          const card = cardId ? cardsMap.get(cardId) ?? null : null;
          return {
            id: pf.id,
            clientSeed: pf.client_seed,
            serverSeedHash: pf.server_seed_hash,
            serverSeed: pf.server_seed,
            nonce: pf.nonce,
            cursor: pf.cursor,
            ticket: pf.ticket,
            resultHash: pf.result_hash,
            resultMetadata: pf.result_metadata,
            card:
              card && valueAtObtained != null
                ? {
                    name: card.name,
                    imageUrl: card.image_url,
                    rarity: card.rarity,
                    valueAtObtained,
                  }
                : null,
          };
        }),
      };
    }
  }

  // Resolve a linked battle id for the transaction so the detail page
  // can offer a Watch link AND (for admins on private battles) the
  // password reveal row. Same fallback chain as getUserTransactions:
  //   1) session.game_type === "battle" → session.game_id is the battle
  //   2) any pf row on the session carrying battle_id
  //   3) tx.metadata.battle_id (older / out-of-session rows)
  // Returns null on any non-battle transaction.
  let battleId: string | null = null;
  if (tx.game_session_id) {
    // We need pf.battle_id and game_type — issue a focused lookup so
    // we don't have to re-shape the heavy session/PF select above.
    const [linkedSession] = await queryMainRows<
      { game_type: string; game_id: string | null; battle_id: string | null }[]
    >(
      `SELECT gs.game_type::text AS game_type, gs.game_id,
              (
                SELECT pf.battle_id
                  FROM provably_fair_results pf
                 WHERE pf.game_session_id = gs.id
                   AND pf.battle_id IS NOT NULL
                 ORDER BY pf.cursor ASC
                 LIMIT 1
              ) AS battle_id
         FROM game_sessions gs
        WHERE gs.id = $1::uuid
        LIMIT 1`,
      tx.game_session_id,
    );
    if (linkedSession?.game_type === "battle" && linkedSession.game_id) {
      battleId = linkedSession.game_id;
    } else if (linkedSession?.battle_id) {
      battleId = linkedSession.battle_id;
    }
  }
  if (!battleId && tx.metadata && typeof tx.metadata === "object") {
    const meta = tx.metadata as Record<string, unknown>;
    if (typeof meta.battle_id === "string") battleId = meta.battle_id;
  }

  // Boolean only — the plaintext password is NEVER carried in the
  // return. Admins fetch it on demand via revealBattlePassword which
  // audit-logs every reveal (`battle_password_viewed`). Matches the
  // SSR-safe pattern getBattleDetail uses.
  let hasPassword = false;
  if (battleId) {
    try {
      const [battle] = await queryMainRows<{ password: string | null }[]>(
        `SELECT password FROM battles WHERE id = $1::uuid LIMIT 1`,
        battleId,
      );
      hasPassword =
        battle?.password != null && battle.password.length > 0;
    } catch (e) {
      console.error(
        "[getTransactionDetail] battle password lookup failed (non-fatal):",
        e,
      );
    }
  }

  return {
    id: tx.id,
    userId: tx.user_id,
    username: tx.username,
    email: tx.email,
    type: tx.type,
    amount,
    balanceBefore,
    balanceAfter,
    gameSessionId: tx.game_session_id,
    gameSession,
    battleId,
    hasPassword,
    cryptoAsset: tx.crypto_asset,
    cryptoAmount: tx.crypto_amount ? toNumber(tx.crypto_amount) : null,
    exchangeRate: tx.exchange_rate ? toNumber(tx.exchange_rate) : null,
    blockchainTxHash: tx.blockchain_tx_hash,
    sourceAddress: tx.source_address,
    destinationAddress: tx.destination_address,
    status: tx.status,
    failureReason: tx.failure_reason,
    description: tx.description,
    metadata: tx.metadata,
    createdAt: tx.created_at.toISOString(),
    updatedAt: tx.updated_at.toISOString(),
  };
}

/**
 * Cross-request cache for the heavy transaction-detail read.
 *
 * `computeTransactionDetail` fans out ~10+ Main-DB round-trips and several
 * of its legs seq-scan on prod (see the doc on `computeTransactionDetail`),
 * so an uncached detail page re-pays that whole fan-out on every load,
 * every 60s AutoRefresh tick, and every segment "Try again" — directly in
 * the connection-pool contention path (the `max: 3` warm-instance pool).
 * A short cache collapses repeat loads of the same tx onto one warmed
 * entry. Ledger rows are immutable + never admin-mutated, so a 30s TTL is
 * safe (the served numbers do not change). Same prod-only, env-resolved-
 * outside pattern as `cachedUserDetail` in users-detail-cache.ts.
 *
 * Keyed on the tx id. Inside the cache callback the request-scoped
 * environment falls back to prod. To avoid serving prod data to a dev-toggled admin we
 * cache ONLY on prod (see {@link getTransactionDetail}); a dev-toggled admin
 * bypasses the cache and reads live.
 */
function cachedTransactionDetail(id: string) {
  return unstable_cache(
    () => computeTransactionDetail(id),
    ["transaction-detail-v1", id],
    { revalidate: 30, tags: ["transaction-detail"] },
  )();
}

/**
 * Public entry point for the transaction-detail page. Resolves the request
 * DB env HERE (cookie read is illegal inside `unstable_cache`): a prod
 * request goes through the cache; a dev-toggled admin reads live so they
 * always see dev data. See {@link computeTransactionDetail} for the query.
 */
export async function getTransactionDetail(id: string) {
  const env = await readDbEnv();
  if (env !== "prod") return computeTransactionDetail(id);
  return cachedTransactionDetail(id);
}
