import { unstable_cache } from "next/cache";
import { getDb, getDevDb, getProdDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import {
  ledger_transaction_type,
  ledger_transaction_status,
} from "@/generated/prisma/enums";
import type { UserTagValue } from "@/lib/queries/user-tags";
import { parseUpgraderMetadata } from "@/lib/utils/upgrader-metadata";
import { officialStreamAdjustmentPrismaWhere } from "@/lib/balance-adjustment-categories";

// Allowlists derived from the generated Prisma enums — used to validate
// user-supplied filter values before they reach the query (instead of an
// unchecked `as` cast). Object.values keeps them in sync with the schema
// automatically.
const LEDGER_TX_TYPES = new Set<string>(Object.values(ledger_transaction_type));
const LEDGER_TX_STATUSES = new Set<string>(
  Object.values(ledger_transaction_status),
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
 * pick the right Prisma client WITHOUT calling `getDb()` (which reads
 * the request cookie via `cookies()` — illegal inside `unstable_cache`).
 * Resolving the env in the request scope and threading it through as a
 * cache-key dimension keeps the dev-DB toggle honest: a dev-toggled
 * admin's cache entry never collides with the prod one.
 */
async function computeDepositTransactions(
  env: DbEnv,
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
  const db = env === "dev" ? getDevDb() : getProdDb();
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * safePerPage;

  // Bind user-provided values via positional parameters to avoid SQL injection.
  const queryParams: unknown[] = [];
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
    LIMIT ${safePerPage}
    OFFSET ${offset}
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

  const [countResult, rows] = await Promise.all([
    db.$queryRawUnsafe<{ total: string }[]>(countSql, ...queryParams),
    db.$queryRawUnsafe<Raw[]>(dataSql, ...queryParams),
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
 * Wraps {@link computeDepositTransactions} in a 60s `unstable_cache`
 * keyed on `(env, page, perPage, search, status, minAmount)`. The
 * arguments passed to a cached function participate in its cache key, so
 * each distinct filter/page combination gets its own entry — switching
 * back to a previously-viewed page is an instant cache hit, and the
 * Active-Timeframe-Only refresh window stays short (60s) so figures
 * don't go stale. Mirrors the `unstable_cache` list pattern in
 * `users-list.ts`.
 *
 * `env` is the FIRST key dimension so a dev-DB-toggled admin's cache
 * entries never collide with the prod ones — behaviour is identical to
 * the uncached `getDb()` path, just memoized.
 */
const cachedDepositTransactions = unstable_cache(
  computeDepositTransactions,
  ["transactions-deposits-list-v1"],
  { revalidate: 60, tags: ["transactions-deposits-list"] },
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
  return cachedDepositTransactions(env, params);
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

export async function getTransactions(params: {
  page?: number;
  perPage?: number;
  search?: string;
  type?: string;
  types?: string[];
  status?: string;
  minAmount?: number;
  maxAmount?: number;
  sortBy?: TransactionSortMode;
}): Promise<PaginatedResult<TransactionListItem>> {
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
  const db = await getDb();

  const where: Prisma.ledger_transactionsWhereInput = {
    // FAKE-BALANCE: hide official_stream adjustments from the transactions
    // list — owner-designated fake balance is never surfaced in any feed.
    // Placed in AND so it combines safely with the search `OR` below and
    // every other filter, and propagates to the pack_multiplier
    // `filterWhere` (which spreads `...where`).
    AND: [{ NOT: officialStreamAdjustmentPrismaWhere() }],
  };

  if (search) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search);
    where.OR = [
      ...(isUuid ? [{ id: search }, { user_id: search }, { metadata: { path: ["battle_id"], equals: search } }] : []),
      { user: { username: { contains: search, mode: "insensitive" as const } } },
    ];
  }

  if (types && types.length > 0) {
    // Drop any value not in the generated enum; only filter if some
    // valid types remain (an all-invalid list shouldn't match nothing).
    const validTypes = types.filter(
      (t): t is ledger_transaction_type => LEDGER_TX_TYPES.has(t),
    );
    if (validTypes.length > 0) where.type = { in: validTypes };
  } else if (type && type !== "all" && LEDGER_TX_TYPES.has(type)) {
    where.type = type as ledger_transaction_type;
  }

  if (status && status !== "all" && LEDGER_TX_STATUSES.has(status)) {
    where.status = status as ledger_transaction_status;
  }

  if (minAmount !== undefined || maxAmount !== undefined) {
    where.amount = {
      ...(minAmount !== undefined ? { gte: minAmount } : {}),
      ...(maxAmount !== undefined ? { lte: maxAmount } : {}),
    };
  }

  // Narrow the ledger_transactions select for the list view: skip the
  // wide JSON `metadata` column plus blockchain/fireblocks/source/dest
  // columns that the table cells don't render. The page only renders the
  // fields below; everything else is detail-page concerns.
  const SELECT = {
    id: true,
    user_id: true,
    type: true,
    balance_before: true,
    balance_after: true,
    status: true,
    description: true,
    created_at: true,
    crypto_asset: true,
    crypto_amount: true,
    user: { select: { username: true, image: true } },
    game_sessions_ledger_transactions_game_session_idTogame_sessions: {
      select: {
        id: true,
        bet_amount: true,
        provably_fair_results: {
          // result_metadata carries the per-result `borrow_percentage`
          // for solo pack opens; for battle rows it's stored on the
          // battle (separate join below). battle_id distinguishes the
          // two so we don't accidentally double-attribute.
          select: {
            battle_id: true,
            result_metadata: true,
            user_inventory: { select: { value_at_obtained: true } },
          },
        },
      },
    },
  } as const;

  let transactions: Prisma.ledger_transactionsGetPayload<{
    select: typeof SELECT;
  }>[];
  let total: number;

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
    const topRows = await db.$queryRaw<{ id: string }[]>`
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
        GROUP BY lt.id, lt.amount
      )
      SELECT id::text AS id
      FROM pack_multipliers
      WHERE payout > 0
      ORDER BY (payout / bet) DESC NULLS LAST
      LIMIT ${PACK_MULTIPLIER_CAP}
    `;
    const topIds = topRows.map((r) => r.id);

    // Apply the user's WHERE filters (search / status / minAmount)
    // ON TOP of the pre-capped ID list — keeps the sort honest if
    // the admin combines it with other filters.
    const filterWhere: Prisma.ledger_transactionsWhereInput = {
      ...where,
      id: { in: topIds },
    };
    const [found, totalCount] = await Promise.all([
      topIds.length === 0
        ? Promise.resolve([])
        : db.ledger_transactions.findMany({
            where: filterWhere,
            select: SELECT,
          }),
      db.ledger_transactions.count({ where: filterWhere }),
    ]);
    // Reorder to match the SQL CTE's multiplier order.
    const byId = new Map(found.map((t) => [t.id, t]));
    const orderedFull = topIds
      .map((id) => byId.get(id))
      .filter((t): t is NonNullable<typeof t> => t != null);
    const sliceStart = (page - 1) * perPage;
    transactions = orderedFull.slice(sliceStart, sliceStart + perPage);
    total = totalCount;
  } else {
    [transactions, total] = await Promise.all([
      db.ledger_transactions.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
        select: SELECT,
      }),
      db.ledger_transactions.count({ where }),
    ]);
  }

  // Battle borrow lookup — for any battle_bet / battle_sponsorship row
  // that has a linked PF result with a battle_id, we need the
  // battles.borrow_percentage to render the badge. One round-trip
  // batched across the visible page; cheaper than letting Prisma fan
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
      const battles = await db.battles.findMany({
        where: { id: { in: [...battleIds] } },
        select: { id: true, borrow_percentage: true },
      });
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
      const vouchers = await db.vouchers.findMany({
        where: { origin_id: { in: [...sessionIds] } },
        select: { origin_id: true, value: true },
      });
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
        if (t.type === "upgrader_bet" && firstPf) {
          const cfg = parseUpgraderMetadata(firstPf.result_metadata);
          upgraderTargetMultiplier = cfg.targetMultiplier;
        }
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
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getTransactionDetail(id: string) {
  const db = await getDb();
  const tx = await db.ledger_transactions.findUnique({
    where: { id },
    include: {
      user: { select: { username: true, email: true } },
    },
  });

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

  if (tx.game_session_id) {
    // Narrow `provably_fair_results` columns to just what downstream uses.
    // The PF table is wide (client_seed, server_seed, server_seed_hash,
    // result_hash, ticket, result_metadata, etc.) but on this page we only
    // join through it to grab the linked inventory item.
    const session = await db.game_sessions.findUnique({
      where: { id: tx.game_session_id },
      select: {
        game_type: true,
        game_id: true,
        bet_amount: true,
        provably_fair_results: {
          // Stable per-row ordering — `cursor` is the per-session
          // index of each PF roll (0 = first card / first spin), so
          // pack opens and upgrader sessions render in play order.
          orderBy: { cursor: "asc" },
          select: {
            // PF proof material — feeds the new "Provably Fair"
            // section on the transaction detail page (mirrors the
            // modal on /users/[id] gaming tab).
            id: true,
            client_seed: true,
            server_seed_hash: true,
            server_seed: true,
            nonce: true,
            cursor: true,
            ticket: true,
            result_hash: true,
            result_metadata: true,
            user_inventory: {
              select: { card_id: true, value_at_obtained: true },
            },
          },
        },
      },
    });

    if (session) {
      // Fetch pack info based on game type, card details, and related
      // transactions in parallel — they're independent.
      let packs: { name: string; imageUrl: string | null; priceUsd: number; quantity: number }[] = [];

      const cardIds = session.provably_fair_results
        .map((pf) => pf.user_inventory?.card_id)
        .filter((cid): cid is string => !!cid);

      const packsPromise =
        session.game_type === "pack"
          ? db.packs
              .findUnique({
                where: { id: session.game_id },
                select: { name: true, image_url: true, price: true, cards_per_open: true },
              })
              .then((pack) => {
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
          ? db.battles
              .findUnique({
                where: { id: session.game_id },
                select: { pack_ids: true, bet_amount: true },
              })
              .then(async (battle) => {
                if (!battle || battle.pack_ids.length === 0) return [];
                const battlePacks = await db.packs.findMany({
                  where: { id: { in: battle.pack_ids } },
                  select: { name: true, image_url: true, price: true },
                });
                return battlePacks.map((p) => ({
                  name: p.name,
                  imageUrl: p.image_url,
                  priceUsd: toNumber(p.price),
                  quantity: 1,
                }));
              })
          : Promise.resolve([] as { name: string; imageUrl: string | null; priceUsd: number; quantity: number }[]);

      const relatedTxsPromise = db.ledger_transactions.findMany({
        where: { game_session_id: tx.game_session_id! },
        orderBy: { created_at: "asc" },
        select: { id: true, type: true, amount: true, balance_before: true, balance_after: true, description: true },
      });

      // Voucher excess this session spun off — parked as a `vouchers`
      // row whose origin_id is the game_session id. Part of what the
      // user won (invariant inventory = cards + vouchers), so it's
      // surfaced alongside the cards on the detail page.
      const vouchersPromise = db.vouchers.findMany({
        where: { origin_id: tx.game_session_id! },
        select: { value: true },
      });

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
        ? db.$queryRaw<{ won_amount: string }[]>`
            SELECT won_amount::text AS won_amount
            FROM upgrader_games
            WHERE id = ${session.game_id}::uuid
          `
        : Promise.resolve([] as { won_amount: string }[]);
      const upgraderInventoryPromise = isUpgrader
        ? db.user_inventory.findMany({
            where: {
              user_id: tx.user_id,
              source_type: "upgrader",
              // Backend convention isn't documented, so accept either
              // the game_sessions.id (consistent with pack/battle) or
              // the upgrader_games.id (game_sessions.game_id). The
              // narrow `in` clause makes either lookup an index hit.
              // tx.game_session_id == game_sessions.id (the row we just
              // selected) so we read it off tx to avoid a redundant
              // `select: { id: true }` on the session query.
              source_id: { in: [tx.game_session_id!, session.game_id!] },
            },
            select: {
              id: true,
              card_id: true,
              value_at_obtained: true,
            },
            orderBy: { obtained_at: "asc" },
          })
        : Promise.resolve(
            [] as Array<{
              id: string;
              card_id: string;
              value_at_obtained: Prisma.Decimal;
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
          ? await db.cards.findMany({
              where: { id: { in: allCardIds } },
              select: { id: true, name: true, image_url: true, rarity: true, price: true },
            })
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
    const linkedSession = await db.game_sessions.findUnique({
      where: { id: tx.game_session_id },
      select: {
        game_type: true,
        game_id: true,
        provably_fair_results: { select: { battle_id: true }, take: 1 },
      },
    });
    if (linkedSession?.game_type === "battle" && linkedSession.game_id) {
      battleId = linkedSession.game_id;
    } else if (linkedSession?.provably_fair_results[0]?.battle_id) {
      battleId = linkedSession.provably_fair_results[0].battle_id;
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
      const battle = await db.battles.findUnique({
        where: { id: battleId },
        select: { password: true },
      });
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
    username: tx.user?.username ?? null,
    email: tx.user?.email ?? null,
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
