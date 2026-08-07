import { queryMainRows } from "@/lib/drizzle-query";
import { unstable_cache } from "next/cache";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { blacklistNotInClause } from "./_blacklist";
import { nonCreatorOwnerSql } from "./_creator-pnl-exclusion";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  officialStreamAdjustmentSqlPredicate,
  removeLockedBalanceAdjustmentSqlPredicate,
  statsExcludedAdjustmentSqlPredicate,
} from "@/lib/balance-adjustment-categories";
import {
  fiatRefundAttributionTimestampSql,
  fiatRefundCreditUsdSql,
} from "./fiat-refund-credits";

/**
 * Ledger-only admin inventory disposals — rows hard-deleted before we
 * switched to stamping `sold_at`. Skips rows whose inventory item still
 * exists (those are counted via `user_inventory.sold_at` instead).
 */
export function adminInventoryRemovalDisposedSql(
  sinceBind: string,
  scopedUserId: string,
): string {
  return `COALESCE((
    SELECT SUM(ABS(lt.amount::numeric))
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.created_at >= ${sinceBind}
      AND lt.type::text = 'admin_balance_adjustment'
      AND lt.metadata->>'kind' = 'inventory_removal'
      AND ${scopedUserId}
      AND NOT EXISTS (
        SELECT 1 FROM user_inventory ui2
        WHERE ui2.id::text = lt.metadata->>'inventory_item_id'
      )
  ), 0)`;
}

/**
 * Ledger-only admin voucher disposals — vouchers hard-deleted before we
 * switched to stamping `claimed_at`. Skips rows whose voucher still exists.
 */
export function adminVoucherRemovalClaimedSql(
  sinceBind: string,
  scopedUserId: string,
): string {
  return `COALESCE((
    SELECT SUM(ABS(lt.amount::numeric))
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.created_at >= ${sinceBind}
      AND lt.type::text = 'admin_balance_adjustment'
      AND lt.metadata->>'kind' = 'voucher_removal'
      AND ${scopedUserId}
      AND NOT EXISTS (
        SELECT 1 FROM vouchers v2
        WHERE v2.id::text = lt.metadata->>'voucher_id'
      )
  ), 0)`;
}

/**
 * Canonical P&L formula — single source of truth.
 *
 * Per CLAUDE.md (House perspective):
 *
 *   pnl = deposits − withdrawals − onSiteBalance − inventoryValue − unclaimedVouchers
 *
 * Sign conventions:
 *   pnl > 0  → House is up (user net-deposited more than they hold)        → 🟢 emerald
 *   pnl < 0  → House is down (user holds more than they net-deposited)     → 🔴 rose
 *
 * `onSiteBalance` = available_balance + locked_balance.
 * `withdrawals`    = balances.total_withdrawn (off-platform payouts only —
 *                    bumped solely by the admin "record off-platform payout"
 *                    action; the card/crypto flow never moves it) +
 *                    sum(card_withdrawal_requests.total_value_usd) for
 *                    IN-FLIGHT + DONE requests, i.e. status IN
 *                    ('pending','processing','shipped','completed').
 *                    Pending/processing are counted as a house liability so
 *                    the P&L stays CONTINUOUS across the withdrawal
 *                    lifecycle — see WITHDRAWAL_LIABILITY_STATUSES below.
 * `inventoryValue` = sum(user_inventory.value_at_obtained) where the row is
 *                    neither sold nor exchanged AND not locked for an
 *                    in-flight withdrawal (withdrawal_locked_at IS NULL).
 *                    The locked value is carried by the `withdrawals` term
 *                    instead, so it is counted exactly once.
 * `unclaimedVouchers` = sum(vouchers.value) where claimed_at IS NULL.
 *
 * House-wide (global) variants may extend this with additional liability
 * components (e.g. unclaimed rakeback). Per-user P&L sticks to the canonical
 * five terms so it lines up with the User Detail panel on the page.
 */

/**
 * Card-withdrawal statuses that count toward the balance-sheet
 * `withdrawals` liability term.
 *
 * Verified mechanism (packy.gg, read against a prod snapshot): a
 * withdrawal — crypto OR physical — bundles `inventory_item_ids` and on
 * creation sets `withdrawal_locked_at` on those rows; `total_value_usd`
 * equals the bundled value. `balances.total_withdrawn` is NOT moved for
 * card/crypto withdrawals — the request's `total_value_usd` is the
 * authoritative record of the outflow, and the counter is reserved for
 * admin-recorded off-platform payouts (see the `withdrawals` note above).
 *
 * CORRECTION (re-verified against prod 2026-07-22): an earlier version of
 * this note claimed "there is no `card_withdrawal` ledger type". That is
 * WRONG — both `card_withdrawal` and `balance_withdrawal` ledger types
 * exist and mirror the request rows (completed: $897,688.52 across 4,201
 * `card_withdrawal` + $229,497.13 across 1,403 `balance_withdrawal`, vs
 * $899,203.43 crypto + $229,497.13 balance completed requests; the crypto
 * gap is the hidden exchange-rate fee spread). They are NOT summed into the
 * `withdrawals` term — the request rows are — but do not reconcile against
 * this file assuming those ledger types are absent.
 *
 * Lifecycle:
 *   pending/processing → value is locked inventory (left open inventory,
 *     not yet a completed outflow). The lifetime balance-sheet P&L
 *     excludes locked inventory (withdrawal_locked_at IS NULL), so unless
 *     we count these here the value VANISHES → house P&L falsely jumps up
 *     by the in-flight amount. Counting them keeps continuity.
 *   shipped/completed → value has actually left the house (items removed
 *     from inventory). Already counted historically.
 *   cancelled/failed → backend restores balance + clears
 *     withdrawal_locked_at, so the value returns to inventory and these
 *     rows are (correctly) excluded.
 *
 * Including pending+processing here while excluding withdrawal-locked
 * inventory means the in-flight value is counted EXACTLY ONCE (as a
 * withdrawal liability, never also as inventory), and a
 * pending→completed transition does not move the figure — the status
 * just shifts from one member of this set to another.
 */
export const WITHDRAWAL_LIABILITY_STATUSES = [
  "pending",
  "processing",
  "shipped",
  "completed",
] as const;

export type PnlComponents = {
  /** Sum of completed deposits credited to the user's balance. */
  deposits: number;
  /**
   * balances.total_withdrawn + card_withdrawal_requests with status IN
   * WITHDRAWAL_LIABILITY_STATUSES (pending/processing/shipped/completed).
   * In-flight withdrawals are counted as a house liability so the P&L is
   * continuous across the withdrawal lifecycle.
   */
  withdrawals: number;
  /** available_balance + locked_balance. */
  onSiteBalance: number;
  /** Open inventory at value_at_obtained. */
  inventoryValue: number;
  /** Outstanding (unclaimed) voucher balance. */
  unclaimedVouchers: number;
};

export type UserPnl = PnlComponents & {
  /** House-perspective P&L per the canonical formula. */
  pnl: number;
};

/**
 * Pure formula. Use this anywhere the components are already in hand to
 * keep the arithmetic in exactly one place.
 */
export function computeHousePnl(c: PnlComponents): number {
  return (
    c.deposits -
    c.withdrawals -
    c.onSiteBalance -
    c.inventoryValue -
    c.unclaimedVouchers
  );
}

/**
 * Compute P&L for a single user.
 *
 * Queries the main DB (game data, not admin DB). Returns numbers so it
 * matches the existing per-user shape consumed by users-detail / users-list
 * — both of which surface JS numbers downstream (Decimal isn't crossable
 * through the RSC boundary anyway).
 *
 * Returns null components zeroed if the user has no balance row yet.
 */
export async function calculateUserPnl(userId: string): Promise<UserPnl> {
  return withTiming("pnl.user", async () => {
    const official = officialStreamAdjustmentSqlPredicate({
      typeColumn: "lt.type",
      metadataColumn: "lt.metadata",
    });
    const removeLocked = removeLockedBalanceAdjustmentSqlPredicate({
      typeColumn: "lt.type",
      metadataColumn: "lt.metadata",
    });
    type Row = {
      available_balance: string;
      locked_balance: string;
      total_deposited: string;
      total_withdrawn: string;
      card_withdrawals: string;
      inventory_value: string;
      voucher_value: string;
      official_stream: string;
      remove_locked: string;
      fiat_refunds: string;
    };
    const [row] = await queryMainRows<Row[]>(
      `SELECT
         COALESCE(b.available_balance, 0)::text AS available_balance,
         COALESCE(b.locked_balance, 0)::text AS locked_balance,
         COALESCE(b.total_deposited, 0)::text AS total_deposited,
         COALESCE(b.total_withdrawn, 0)::text AS total_withdrawn,
         COALESCE((SELECT SUM(cwr.total_value_usd::numeric)
                   FROM card_withdrawal_requests cwr
                   WHERE cwr.user_id = $1
                     AND cwr.status::text = ANY($2::text[])), 0)::text AS card_withdrawals,
         COALESCE((SELECT SUM(ui.value_at_obtained::numeric)
                   FROM user_inventory ui
                   JOIN "user" u ON u.id = ui.user_id
                   WHERE ui.user_id = $1
                     AND ui.sold_at IS NULL AND ui.exchanged_at IS NULL
                     AND ui.withdrawal_locked_at IS NULL
                     AND u.role::text <> 'creator'), 0)::text AS inventory_value,
         COALESCE((SELECT SUM(v.value::numeric)
                   FROM vouchers v WHERE v.user_id = $1 AND v.claimed_at IS NULL), 0)::text AS voucher_value,
         COALESCE((SELECT SUM(lt.amount::numeric)
                   FROM ledger_transactions lt
                   WHERE lt.user_id = $1 AND lt.status::text = 'completed'
                     AND ${official}), 0)::text AS official_stream,
         COALESCE((SELECT SUM(lt.amount::numeric)
                   FROM ledger_transactions lt
                   WHERE lt.user_id = $1 AND lt.status::text = 'completed'
                     AND ${removeLocked}), 0)::text AS remove_locked
         ,COALESCE((SELECT SUM(${fiatRefundCreditUsdSql("i")})
                    FROM fiat_deposit_intents i
                    WHERE i.user_id = $1
                      AND i.status IN ('partially_refunded', 'refunded')), 0)::text AS fiat_refunds
       FROM (SELECT $1::text AS user_id) requested
       LEFT JOIN balances b ON b.user_id = requested.user_id`,
      userId,
      [...WITHDRAWAL_LIABILITY_STATUSES],
    );

    const components: PnlComponents = {
      deposits:
        toNumber(row?.total_deposited) - toNumber(row?.fiat_refunds),
      withdrawals:
        toNumber(row?.total_withdrawn) + toNumber(row?.card_withdrawals),
      onSiteBalance:
        toNumber(row?.available_balance) +
        toNumber(row?.locked_balance) -
        toNumber(row?.official_stream) -
        toNumber(row?.remove_locked),
      inventoryValue: toNumber(row?.inventory_value),
      unclaimedVouchers: toNumber(row?.voucher_value),
    };

    return { ...components, pnl: computeHousePnl(components) };
  });
}
export type WindowedPnl = {
  deposits: number;
  withdrawals: number;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  /** House P&L over the window — see formula below. */
  pnl: number;
};

/**
 * House P&L over a ROLLING window `[since, now)` — the windowed-delta
 * form of the canonical formula:
 *
 *   pnl = Δdeposits − Δwithdrawals − Δbalance − Δinventory − Δvouchers
 *
 * which equals `lifetime_pnl(now) − lifetime_pnl(since)`. Each Δ is the
 * change over the window. Component definitions match the per-creator
 * period P&L in `code-and-wager-by-user.ts` so every windowed P&L on
 * the site agrees.
 *
 * NOTE: this is the rolling "past N hours/days" form (e.g. now − 24h),
 * NOT a calendar-day figure. It also intentionally omits the unclaimed-
 * rakeback liability that the lifetime *snapshot* (getRealizedPnlSnapshot)
 * carries — windowed P&L tracks the five movement components only.
 *
 * Scope: pass `userId` for a single user; omit it for a global figure
 * across real users (admin/support + the excluded-users blacklist
 * dropped, same as the dashboard aggregates).
 *
 * POPULATION RESTRICTION: pass `populationScopeSql` (a self-contained SQL
 * boolean fragment referencing the `"user" u` alias of the global scope
 * subquery, e.g. `u.referred_by IS NOT NULL`) to further narrow the global
 * cohort to a sub-population — used by the affiliate-referred-players P&L
 * box. The fragment is ANDed INTO the existing
 * `id IN (SELECT id FROM "user" u WHERE ...)` subquery, so the canonical
 * 5-term money math + the official_stream netting below stay identical;
 * only WHICH users are summed changes. It is ignored when `userId` is set
 * (a single user is already a fully-resolved scope). MUST be a trusted,
 * hardcoded fragment (never user input) — it is inlined into the SQL.
 */
/** Raw one-row-per-leg aggregate output of the windowed-P&L SQL. */
type WindowedPnlLegRow = {
  deposits: string | null;
  manual_wd: string | null;
  balance_change: string | null;
  card_wd: string | null;
  obtained: string | null;
  disposed: string | null;
  issued: string | null;
  claimed: string | null;
  refunds: string | null;
};

/**
 * The five windowed-P&L leg queries as SQL text, parameterized ONLY by how a
 * user-scope predicate is spelled. Single source of truth for the money math:
 * both `calculateWindowedPnl` (five parallel round-trips) and
 * `calculateWindowedPnlOneShot` (one round-trip, CTE scope) build their SQL
 * from here, so the two paths can never drift apart.
 *
 * `$1` is always the window start. `scope(col)` must emit a self-contained
 * boolean predicate restricting `col` to the cohort.
 */
function windowedPnlLegSql(scope: (col: string) => string) {
  const statsExcluded = statsExcludedAdjustmentSqlPredicate({
    typeColumn: "lt.type",
    metadataColumn: "lt.metadata",
  });
  const userScopeLt = scope("lt.user_id");
  return {
    ledger: `SELECT
         COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::text AS deposits,
         COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                            AND lt.balance_after < lt.balance_before
                            AND lt.description ILIKE 'Manual withdrawal:%'
                           THEN lt.amount::numeric ELSE 0 END), 0)::text AS manual_wd,
         COALESCE(SUM(CASE WHEN ${statsExcluded} THEN 0 ELSE (lt.balance_after - lt.balance_before)::numeric END), 0)::text AS balance_change
       FROM ledger_transactions lt
       WHERE lt.status = 'completed' AND lt.created_at >= $1 AND ${userScopeLt}`,
    card: `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS card_wd
       FROM card_withdrawal_requests cwr
       WHERE cwr.status IN ('completed', 'shipped')
         AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $1
         AND ${scope("cwr.user_id")}`,
    // CREATOR-INVENTORY carve-out: drop creator-owned inventory from BOTH
    // the obtained and disposed legs symmetrically (incl. admin removals)
    // so the windowed delta matches the lifetime liability carve-out. See
    // _creator-pnl-exclusion.ts.
    inv: `SELECT
         COALESCE(SUM(CASE WHEN ui.obtained_at >= $1 THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS obtained,
         (
           COALESCE(SUM(CASE WHEN (ui.sold_at >= $1 OR ui.exchanged_at >= $1) THEN ui.value_at_obtained::numeric ELSE 0 END), 0)
           + ${adminInventoryRemovalDisposedSql("$1", `${userScopeLt} AND ${nonCreatorOwnerSql("lt.user_id")}`)}
         )::text AS disposed
       FROM user_inventory ui
       WHERE (ui.obtained_at >= $1 OR ui.sold_at >= $1 OR ui.exchanged_at >= $1)
         AND ${scope("ui.user_id")}
         AND ${nonCreatorOwnerSql("ui.user_id")}`,
    vch: `SELECT
         COALESCE(SUM(CASE WHEN v.created_at >= $1 THEN v.value::numeric ELSE 0 END), 0)::text AS issued,
         (
           COALESCE(SUM(CASE WHEN v.claimed_at >= $1 THEN v.value::numeric ELSE 0 END), 0)
           + ${adminVoucherRemovalClaimedSql("$1", userScopeLt)}
         )::text AS claimed
       FROM vouchers v
       WHERE (v.created_at >= $1 OR v.claimed_at >= $1)
         AND ${scope("v.user_id")}`,
    refunds: `SELECT COALESCE(SUM(${fiatRefundCreditUsdSql("i")}), 0)::text AS refunds
       FROM fiat_deposit_intents i
       WHERE i.status IN ('partially_refunded', 'refunded')
         AND ${fiatRefundAttributionTimestampSql("i")} >= $1
         AND ${scope("i.user_id")}`,
  };
}

/**
 * The canonical five-term arithmetic, applied to one row of raw leg sums.
 * Shared by every windowed-P&L path so the formula lives in exactly one place.
 *
 * Upgrader payouts are fully captured by `balanceChange` — the ledger carries
 * both upgrader_bet (debit) and upgrader_payout (credit) rows, so no separate
 * `upgrader_games` correction is needed here. A prior trailing term was based
 * on a stale assumption that the backend never wrote upgrader_payout rows;
 * that double-subtracted every upgrader win and inflated the surfaced house
 * loss.
 */
function combineWindowedPnlLegs(row: WindowedPnlLegRow | undefined): WindowedPnl {
  const deposits = toNumber(row?.deposits) - toNumber(row?.refunds);
  const manualWd = toNumber(row?.manual_wd);
  const cardWd = toNumber(row?.card_wd);
  const withdrawalsGross = Math.abs(manualWd) + cardWd;
  const balanceChange = toNumber(row?.balance_change);
  const inventoryChange = toNumber(row?.obtained) - toNumber(row?.disposed);
  const voucherChange = toNumber(row?.issued) - toNumber(row?.claimed);
  const pnl =
    deposits -
    (manualWd + cardWd) -
    balanceChange -
    inventoryChange -
    voucherChange;

  return {
    deposits,
    withdrawals: withdrawalsGross,
    balanceChange,
    inventoryChange,
    voucherChange,
    pnl,
  };
}

export type WindowedPnlOpts = {
  since: Date;
  userId?: string;
  excludeUserIds?: string[];
  /**
   * Optional trusted SQL boolean fragment (referencing the `"user" u`
   * alias) that further restricts the GLOBAL real-user cohort to a
   * sub-population. Ignored when `userId` is set. Hardcoded only — inlined
   * into the scope subquery.
   */
  populationScopeSql?: string;
};

export async function calculateWindowedPnl(
  opts: WindowedPnlOpts,
): Promise<WindowedPnl> {
  const { since, userId, excludeUserIds = [], populationScopeSql } = opts;
  return withTiming("pnl.windowed", async () => {

    // Per-table user scope. Single-user binds the id as positional $2;
    // global filters to non-staff users minus the blacklist (ids come
    // from a trusted admin source, escaped defensively). An optional
    // `populationScopeSql` (trusted, hardcoded) ANDs into the global
    // subquery to narrow the cohort to a sub-population (e.g. affiliate-
    // referred players) without changing the money math.
    const blacklist = blacklistNotInClause("u.id", excludeUserIds);
    const populationAnd =
      populationScopeSql && populationScopeSql.trim().length > 0
        ? ` AND (${populationScopeSql})`
        : "";
    const scope = (col: string) =>
      userId
        ? `${col} = $2`
        : `${col} IN (SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support') ${blacklist}${populationAnd})`;
    const params: unknown[] = userId ? [since, userId] : [since];
    const legs = windowedPnlLegSql(scope);

    type LedgerRow = { deposits: string; manual_wd: string; balance_change: string };
    type RefundRow = { refunds: string };
    type CardRow = { card_wd: string };
    type InvRow = { obtained: string; disposed: string };
    type VchRow = { issued: string; claimed: string };

    const [ledger, card, inv, vch, refunds] = await Promise.all([
      queryMainRows<LedgerRow[]>(legs.ledger, ...params),
      queryMainRows<CardRow[]>(legs.card, ...params),
      queryMainRows<InvRow[]>(legs.inv, ...params),
      queryMainRows<VchRow[]>(legs.vch, ...params),
      queryMainRows<RefundRow[]>(legs.refunds, ...params),
    ]);

    return combineWindowedPnlLegs({
      ...ledger[0],
      ...card[0],
      ...inv[0],
      ...vch[0],
      ...refunds[0],
    } as WindowedPnlLegRow);
  });
}

/**
 * Same windowed-delta P&L as {@link calculateWindowedPnl} — cent-identical by
 * construction (both build their SQL from `windowedPnlLegSql` and combine it
 * with `combineWindowedPnlLegs`) — but as a SINGLE statement over ONE
 * connection instead of five parallel round-trips.
 *
 * Why it exists: the MAIN read pool is tiny (see the pool-stampede incident),
 * so an UNCACHED tile that fires five concurrent queries per render is five
 * pool slots per viewer. This variant takes one slot and one round-trip, and
 * resolves the non-staff cohort ONCE in a MATERIALIZED CTE rather than
 * re-running the same `"user"` scan inside each of the five legs. That makes
 * it cheap enough to run on every dashboard render with no cache in front of
 * it (see `getTodayPnl`).
 *
 * Trade-off vs. the parallel form: the legs run sequentially inside Postgres,
 * so wall-clock is the SUM of the legs rather than the max. For a short
 * window (today) that is ~100ms; for long windows prefer the parallel form.
 */
export async function calculateWindowedPnlOneShot(
  opts: WindowedPnlOpts,
): Promise<WindowedPnl> {
  const { since, userId, excludeUserIds = [], populationScopeSql } = opts;
  return withTiming("pnl.windowedOneShot", async () => {
    const blacklist = blacklistNotInClause("u.id", excludeUserIds);
    const populationAnd =
      populationScopeSql && populationScopeSql.trim().length > 0
        ? ` AND (${populationScopeSql})`
        : "";
    // The cohort is resolved once, up front. `MATERIALIZED` is deliberate:
    // without it Postgres inlines the CTE into all five legs and we are back
    // to re-scanning `"user"` per leg.
    const scopedUsersCte = userId
      ? `SELECT $2::text AS id`
      : `SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support') ${blacklist}${populationAnd}`;
    const params: unknown[] = userId ? [since, userId] : [since];
    const legs = windowedPnlLegSql(
      (col) => `${col} IN (SELECT id FROM scoped_users)`,
    );

    const rows = await queryMainRows<WindowedPnlLegRow[]>(
      `WITH scoped_users AS MATERIALIZED (${scopedUsersCte}),
            leg_ledger  AS (${legs.ledger}),
            leg_card    AS (${legs.card}),
            leg_inv     AS (${legs.inv}),
            leg_vch     AS (${legs.vch}),
            leg_refunds AS (${legs.refunds})
       SELECT leg_ledger.deposits,
              leg_ledger.manual_wd,
              leg_ledger.balance_change,
              leg_card.card_wd,
              leg_inv.obtained,
              leg_inv.disposed,
              leg_vch.issued,
              leg_vch.claimed,
              leg_refunds.refunds
       FROM leg_ledger, leg_card, leg_inv, leg_vch, leg_refunds`,
      ...params,
    );

    return combineWindowedPnlLegs(rows[0]);
  });
}

/**
 * House P&L per user over a bounded window `[start, end)` — the same five-term
 * windowed-delta formula as `calculateWindowedPnl`, batched for many users in
 * one round-trip per source table. Used by affiliate-leaderboard standings so
 * each row can show house P&L inside the event window without N×4 queries.
 *
 * Users with no qualifying activity in the window are absent from the returned
 * map (callers should default to 0).
 */
export async function calculateUsersBoundedWindowedPnlBatch(
  userIds: string[],
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (userIds.length === 0) return result;

  return withTiming("pnl.usersBoundedWindowedBatch", async () => {
    const statsExcluded = statsExcludedAdjustmentSqlPredicate({
      typeColumn: "lt.type",
      metadataColumn: "lt.metadata",
    });

    type LedgerRow = {
      user_id: string;
      deposits: string;
      manual_wd: string;
      balance_change: string;
    };
    type AmountRow = { user_id: string; amount: string };
    type InvRow = { user_id: string; obtained: string; ui_disposed: string };

    const [ledger, card, inv, adminInv, vchIssued, vchClaimed, adminVch, refunds] =
      await Promise.all([
      queryMainRows<LedgerRow[]>(
        `SELECT lt.user_id,
           COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::text AS deposits,
           COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                              AND lt.balance_after < lt.balance_before
                              AND lt.description ILIKE 'Manual withdrawal:%'
                             THEN lt.amount::numeric ELSE 0 END), 0)::text AS manual_wd,
           COALESCE(SUM(CASE WHEN ${statsExcluded} THEN 0 ELSE (lt.balance_after - lt.balance_before)::numeric END), 0)::text AS balance_change
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $2
           AND lt.created_at <  $3
           AND lt.user_id = ANY($1::text[])
         GROUP BY lt.user_id`,
        userIds,
        start,
        end,
      ),
      queryMainRows<AmountRow[]>(
        `SELECT cwr.user_id,
           COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS amount
         FROM card_withdrawal_requests cwr
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $2
           AND COALESCE(cwr.shipped_at, cwr.completed_at) <  $3
           AND cwr.user_id = ANY($1::text[])
         GROUP BY cwr.user_id`,
        userIds,
        start,
        end,
      ),
      queryMainRows<InvRow[]>(
        `SELECT ui.user_id,
           COALESCE(SUM(CASE WHEN ui.obtained_at >= $2 AND ui.obtained_at < $3
                             THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS obtained,
           COALESCE(SUM(CASE WHEN (ui.sold_at >= $2 AND ui.sold_at < $3)
                               OR (ui.exchanged_at >= $2 AND ui.exchanged_at < $3)
                             THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS ui_disposed
         FROM user_inventory ui
         WHERE ui.user_id = ANY($1::text[])
           AND (
             (ui.obtained_at >= $2 AND ui.obtained_at < $3)
             OR (ui.sold_at >= $2 AND ui.sold_at < $3)
             OR (ui.exchanged_at >= $2 AND ui.exchanged_at < $3)
           )
         GROUP BY ui.user_id`,
        userIds,
        start,
        end,
      ),
      queryMainRows<AmountRow[]>(
        `SELECT lt.user_id,
           COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS amount
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $2
           AND lt.created_at <  $3
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.metadata->>'kind' = 'inventory_removal'
           AND lt.user_id = ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM user_inventory ui2
             WHERE ui2.id::text = lt.metadata->>'inventory_item_id'
           )
         GROUP BY lt.user_id`,
        userIds,
        start,
        end,
      ),
      queryMainRows<AmountRow[]>(
        `SELECT v.user_id,
           COALESCE(SUM(v.value::numeric), 0)::text AS amount
         FROM vouchers v
         WHERE v.user_id = ANY($1::text[])
           AND v.created_at >= $2
           AND v.created_at <  $3
         GROUP BY v.user_id`,
        userIds,
        start,
        end,
      ),
      queryMainRows<AmountRow[]>(
        `SELECT v.user_id,
           COALESCE(SUM(v.value::numeric), 0)::text AS amount
         FROM vouchers v
         WHERE v.user_id = ANY($1::text[])
           AND v.claimed_at >= $2
           AND v.claimed_at <  $3
         GROUP BY v.user_id`,
        userIds,
        start,
        end,
      ),
      queryMainRows<AmountRow[]>(
        `SELECT lt.user_id,
           COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS amount
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $2
           AND lt.created_at <  $3
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.metadata->>'kind' = 'voucher_removal'
           AND lt.user_id = ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM vouchers v2
             WHERE v2.id::text = lt.metadata->>'voucher_id'
           )
         GROUP BY lt.user_id`,
        userIds,
        start,
        end,
      ),
      queryMainRows<AmountRow[]>(
        `SELECT i.user_id,
           COALESCE(SUM(${fiatRefundCreditUsdSql("i")}), 0)::text AS amount
         FROM fiat_deposit_intents i
         WHERE i.status IN ('partially_refunded', 'refunded')
           AND ${fiatRefundAttributionTimestampSql("i")} >= $2
           AND ${fiatRefundAttributionTimestampSql("i")} < $3
           AND i.user_id = ANY($1::text[])
         GROUP BY i.user_id`,
        userIds,
        start,
        end,
      ),
    ]);

    const ledgerByUser = new Map(ledger.map((r) => [r.user_id, r]));
    const cardByUser = new Map(card.map((r) => [r.user_id, r]));
    const invByUser = new Map(inv.map((r) => [r.user_id, r]));
    const adminInvByUser = new Map(adminInv.map((r) => [r.user_id, r]));
    const vchIssuedByUser = new Map(vchIssued.map((r) => [r.user_id, r]));
    const vchClaimedByUser = new Map(vchClaimed.map((r) => [r.user_id, r]));
    const adminVchByUser = new Map(adminVch.map((r) => [r.user_id, r]));
    const refundsByUser = new Map(refunds.map((r) => [r.user_id, r]));

    for (const userId of userIds) {
      const lt = ledgerByUser.get(userId);
      const deposits =
        toNumber(lt?.deposits) -
        toNumber(refundsByUser.get(userId)?.amount);
      const manualWd = toNumber(lt?.manual_wd);
      const cardWd = toNumber(cardByUser.get(userId)?.amount);
      const balanceChange = toNumber(lt?.balance_change);
      const invRow = invByUser.get(userId);
      const inventoryChange =
        toNumber(invRow?.obtained) -
        (toNumber(invRow?.ui_disposed) +
          toNumber(adminInvByUser.get(userId)?.amount));
      const voucherChange =
        toNumber(vchIssuedByUser.get(userId)?.amount) -
        (toNumber(vchClaimedByUser.get(userId)?.amount) +
          toNumber(adminVchByUser.get(userId)?.amount));
      const pnl =
        deposits -
        (manualWd + cardWd) -
        balanceChange -
        inventoryChange -
        voucherChange;
      result.set(userId, pnl);
    }

    return result;
  });
}

/**
 * Compute P&L for many users in a single round-trip per component table
 * — N+1 safe. Returns a Map keyed by userId. Missing users get a zeroed
 * record so callers can `map.get(id) ?? ZERO_PNL` without guards.
 *
 * Exists so users-list can avoid serializing 5×N queries; one groupBy per
 * table covers the whole page.
 */
export async function calculateUsersPnlBatch(
  userIds: string[],
): Promise<Map<string, UserPnl>> {
  const result = new Map<string, UserPnl>();
  if (userIds.length === 0) return result;

  return withTiming("pnl.usersBatch", async () => {
    const official = officialStreamAdjustmentSqlPredicate({
      typeColumn: "lt.type",
      metadataColumn: "lt.metadata",
    });
    const removeLocked = removeLockedBalanceAdjustmentSqlPredicate({
      typeColumn: "lt.type",
      metadataColumn: "lt.metadata",
    });
    type Row = {
      user_id: string;
      available_balance: string;
      locked_balance: string;
      total_deposited: string;
      total_withdrawn: string;
      card_withdrawals: string;
      inventory_value: string;
      voucher_value: string;
      official_stream: string;
      remove_locked: string;
    };
    const rows = await queryMainRows<Row[]>(
      `WITH requested AS (SELECT unnest($1::text[]) AS user_id),
       card AS (
         SELECT user_id, SUM(total_value_usd::numeric) AS amount
         FROM card_withdrawal_requests
         WHERE user_id = ANY($1::text[]) AND status::text = ANY($2::text[])
         GROUP BY user_id
       ),
       inventory AS (
         SELECT ui.user_id, SUM(ui.value_at_obtained::numeric) AS amount
         FROM user_inventory ui JOIN "user" u ON u.id = ui.user_id
         WHERE ui.user_id = ANY($1::text[]) AND ui.sold_at IS NULL
           AND ui.exchanged_at IS NULL AND ui.withdrawal_locked_at IS NULL
           AND u.role::text <> 'creator'
         GROUP BY ui.user_id
       ),
       voucher AS (
         SELECT user_id, SUM(value::numeric) AS amount FROM vouchers
         WHERE user_id = ANY($1::text[]) AND claimed_at IS NULL GROUP BY user_id
       ),
       adjustments AS (
         SELECT lt.user_id,
           SUM(lt.amount::numeric) FILTER (WHERE ${official}) AS official_stream,
           SUM(lt.amount::numeric) FILTER (WHERE ${removeLocked}) AS remove_locked
         FROM ledger_transactions lt
         WHERE lt.user_id = ANY($1::text[]) AND lt.status::text = 'completed'
           AND (${official} OR ${removeLocked})
         GROUP BY lt.user_id
       ),
       fiat_refunds AS (
         SELECT i.user_id, SUM(${fiatRefundCreditUsdSql("i")}) AS amount
         FROM fiat_deposit_intents i
         WHERE i.user_id = ANY($1::text[])
           AND i.status IN ('partially_refunded', 'refunded')
         GROUP BY i.user_id
       )
       SELECT requested.user_id,
         COALESCE(b.available_balance, 0)::text AS available_balance,
         COALESCE(b.locked_balance, 0)::text AS locked_balance,
         (COALESCE(b.total_deposited, 0) - COALESCE(fiat_refunds.amount, 0))::text AS total_deposited,
         COALESCE(b.total_withdrawn, 0)::text AS total_withdrawn,
         COALESCE(card.amount, 0)::text AS card_withdrawals,
         COALESCE(inventory.amount, 0)::text AS inventory_value,
         COALESCE(voucher.amount, 0)::text AS voucher_value,
         COALESCE(adjustments.official_stream, 0)::text AS official_stream,
         COALESCE(adjustments.remove_locked, 0)::text AS remove_locked
       FROM requested
       LEFT JOIN balances b USING (user_id)
       LEFT JOIN card USING (user_id)
       LEFT JOIN inventory USING (user_id)
       LEFT JOIN voucher USING (user_id)
       LEFT JOIN adjustments USING (user_id)
       LEFT JOIN fiat_refunds USING (user_id)`,
      userIds,
      [...WITHDRAWAL_LIABILITY_STATUSES],
    );

    for (const row of rows) {
      const components: PnlComponents = {
        deposits: toNumber(row.total_deposited),
        withdrawals:
          toNumber(row.total_withdrawn) + toNumber(row.card_withdrawals),
        onSiteBalance:
          toNumber(row.available_balance) +
          toNumber(row.locked_balance) -
          toNumber(row.official_stream) -
          toNumber(row.remove_locked),
        inventoryValue: toNumber(row.inventory_value),
        unclaimedVouchers: toNumber(row.voucher_value),
      };
      result.set(row.user_id, {
        ...components,
        pnl: computeHousePnl(components),
      });
    }

    return result;
  });
}
export type DailyPnlPoint = {
  /** YYYY-MM-DD */
  date: string;
  /** House P&L for that day (windowed-delta formula, bucketed per day). */
  pnl: number;
  /** Gross deposits that day (context for the chart hover). */
  deposits: number;
  /** Gross withdrawals that day — |manual| + card (context for hover). */
  withdrawals: number;
  /**
   * Per-day windowed-delta components — the same terms `pnl` is built
   * from, surfaced so the chart hover can show WHERE each day's money
   * went (deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ = pnl).
   * Net change in user available + locked balance for the day.
   */
  balanceChange: number;
  /** Cards obtained minus cards sold/exchanged that day (signed). */
  inventoryChange: number;
  /** Vouchers issued minus vouchers claimed that day (signed). */
  voucherChange: number;
};

/**
 * Allowed day-windows for the daily P&L series. Doubles as the SQL whitelist:
 * the interval interpolated into `computeDailyPnl` comes from this map, never
 * from the caller's value directly. 30 stays the default so the dashboard
 * consumers are byte-identical to the pre-parametrized query.
 */
export type DailyPnlWindowDays = 7 | 30 | 90;
const DAILY_PNL_WINDOWS: Record<DailyPnlWindowDays, number> = {
  7: 7,
  30: 30,
  90: 90,
};

/**
 * Daily house P&L for the last `days` days — the per-day breakdown of the same
 * windowed formula `calculateWindowedPnl` uses:
 *
 *   pnl = Δdeposits − Δwithdrawals − Δbalance − Δinventory − Δvouchers
 *
 * Each component is bucketed by its own event date (ledger by created_at,
 * card withdrawals by ship/complete date, inventory by obtained vs disposal
 * date, vouchers by created vs claimed date) and combined per day. Because
 * the formula is linear and every event belongs to exactly one day, the
 * daily values sum to the rolling windowed P&L — so this is consistent with
 * the dashboard's P&L card, not a different GGR-style metric.
 *
 * Global figure across real users (admin/support + the excluded-users
 * blacklist dropped), matching the dashboard aggregates. Standalone (not
 * part of getDashboardStats) so it streams behind its own Suspense.
 */
async function computeDailyPnl(
  excluded: string[],
  days: DailyPnlWindowDays,
): Promise<DailyPnlPoint[]> {
  return withTiming("pnl.daily", async () => {
    // `days` is the validated 7|30|90 union — DAILY_PNL_WINDOWS is the
    // whitelist, so the interpolation below can never carry anything but one
    // of those three integers into the SQL.
    const windowDays = DAILY_PNL_WINDOWS[days];
    const blacklist = blacklistNotInClause("u.id", excluded);
    const usersScope = `(SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support') ${blacklist})`;
    const statsExcluded = statsExcludedAdjustmentSqlPredicate({
      typeColumn: "lt.type",
      metadataColumn: "lt.metadata",
    });
    const ledgerUserScope = `lt.user_id IN ${usersScope}`;

    type LedgerRow = {
      d: Date;
      deposits: number;
      manual_wd: number;
      balance_change: number;
    };
    type RefundRow = { d: Date; refunds: number };
    type CardRow = { d: Date; card_wd: number };
    type InvRow = { d: Date; obtained: number; disposed: number };
    type VchRow = { d: Date; issued: number; claimed: number };

    const [ledger, card, inv, vch, refunds] = await Promise.all([
      queryMainRows<LedgerRow[]>(
        `SELECT DATE(lt.created_at) AS d,
           COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS deposits,
           COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                              AND lt.balance_after < lt.balance_before
                              AND lt.description ILIKE 'Manual withdrawal:%'
                             THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS manual_wd,
           COALESCE(SUM(CASE WHEN ${statsExcluded} THEN 0 ELSE (lt.balance_after - lt.balance_before)::numeric END), 0)::float8 AS balance_change
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND lt.created_at >= NOW() - INTERVAL '${windowDays} days'
           AND lt.user_id IN ${usersScope}
         GROUP BY DATE(lt.created_at)`,
      ),
      queryMainRows<CardRow[]>(
        // CLOSED-DAY FINALITY — the withdrawal term is the ONLY one that can
        // retroactively flip a CLOSED day green→loss, so it is bucketed by
        // the realized money-out timestamp (NOT requested_at/created_at) and
        // kept consistent with the rest of the P&L family.
        //
        // Why only THIS term moves a closed day:
        // • deposits self-cancel: a late-completing deposit adds +amount to
        //   `deposits` AND +amount to `balance_change` (it credits the user's
        //   balance), so net 0 on that day's P&L — a closed day can't move.
        // • admin balance adjustments are written atomically as
        //   status='completed' (users/[id]/actions.ts), so they never appear
        //   in a past day after the fact.
        // • inventory (obtained_at / sold_at / exchanged_at) and voucher
        //   (created_at / claimed_at) legs are stamped at the event instant,
        //   so a next-day sell/redeem carries a next-day stamp.
        // • a card withdrawal writes NO offsetting ledger row (there is no
        //   `card_withdrawal` ledger type and `total_withdrawn` is not moved
        //   — see WITHDRAWAL_LIABILITY_STATUSES). So its `total_value_usd`
        //   lands with no counterweight: if it slips into a closed day after
        //   the fact, that day drops by the FULL amount.
        //
        // Bucketing key: COALESCE(shipped_at, completed_at) — the same key
        // the windowed P&L (calculateWindowedPnl) and the "P&L Today" tile
        // (getTodayPnl) use, so the daily bar reconciles with them.
        //   • shipped_at is stamped new Date() the instant the admin ships
        //     (withdrawals/actions.ts:shipWithdrawal) — immutable + never
        //     backdated — so a PHYSICAL withdrawal is pinned to its ship-day
        //     and never drifts to the later complete-day (that is why this
        //     order, not completed-first, is the finality-correct one: a
        //     shipped row already counts on its ship-day and must stay there).
        //   • a CRYPTO withdrawal has shipped_at = NULL, so it is bucketed by
        //     completed_at.
        //
        // KNOWN RESIDUAL — backend-owned, NOT fixable in this main-DB query:
        // a CRYPTO withdrawal whose `completed_at` the backend records as the
        // ON-CHAIN SETTLEMENT instant (which can fall LATE inside a day D)
        // while the row is only transitioned to status='completed' AFTER D
        // has closed will still attribute to D — and the dashboard's 60s
        // auto-refresh then re-renders the (now-closed) D bar with it
        // included, flipping it. The row carries NO timestamp recording the
        // later status transition (the panel does not stamp completion;
        // completeWithdrawal delegates to the remote `/admin/complete`), and
        // the only panel-stamped record of the transition lives in the ADMIN
        // DB audit log, which this main-DB query cannot join (dual-DB rule).
        // Closing this fully requires the backend to either set
        // completed_at = now() at completion, or add a separate
        // completion-recorded-at column to bucket on. Flagged to the owner.
        `SELECT DATE(COALESCE(cwr.shipped_at, cwr.completed_at)) AS d,
           COALESCE(SUM(cwr.total_value_usd::numeric), 0)::float8 AS card_wd
         FROM card_withdrawal_requests cwr
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.shipped_at, cwr.completed_at) >= NOW() - INTERVAL '${windowDays} days'
           AND cwr.user_id IN ${usersScope}
         GROUP BY DATE(COALESCE(cwr.shipped_at, cwr.completed_at))`,
      ),
      queryMainRows<InvRow[]>(
        `SELECT d,
           COALESCE(SUM(obtained), 0)::float8 AS obtained,
           COALESCE(SUM(disposed), 0)::float8 AS disposed
         FROM (
           SELECT DATE(ui.obtained_at) AS d, ui.value_at_obtained::numeric AS obtained, 0::numeric AS disposed
           FROM user_inventory ui
           WHERE ui.obtained_at >= NOW() - INTERVAL '${windowDays} days' AND ui.user_id IN ${usersScope}
             AND ${nonCreatorOwnerSql("ui.user_id")}
           UNION ALL
           SELECT DATE(COALESCE(ui.sold_at, ui.exchanged_at)) AS d, 0::numeric AS obtained, ui.value_at_obtained::numeric AS disposed
           FROM user_inventory ui
           WHERE (ui.sold_at >= NOW() - INTERVAL '${windowDays} days' OR ui.exchanged_at >= NOW() - INTERVAL '${windowDays} days')
             AND ui.user_id IN ${usersScope}
             AND ${nonCreatorOwnerSql("ui.user_id")}
           UNION ALL
           SELECT DATE(lt.created_at) AS d, 0::numeric AS obtained, ABS(lt.amount::numeric) AS disposed
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.created_at >= NOW() - INTERVAL '${windowDays} days'
             AND lt.type::text = 'admin_balance_adjustment'
             AND lt.metadata->>'kind' = 'inventory_removal'
             AND ${ledgerUserScope}
             AND ${nonCreatorOwnerSql("lt.user_id")}
             AND NOT EXISTS (
               SELECT 1 FROM user_inventory ui2
               WHERE ui2.id::text = lt.metadata->>'inventory_item_id'
             )
         ) x
         GROUP BY d`,
      ),
      queryMainRows<VchRow[]>(
        `SELECT d,
           COALESCE(SUM(issued), 0)::float8 AS issued,
           COALESCE(SUM(claimed), 0)::float8 AS claimed
         FROM (
           SELECT DATE(v.created_at) AS d, v.value::numeric AS issued, 0::numeric AS claimed
           FROM vouchers v
           WHERE v.created_at >= NOW() - INTERVAL '${windowDays} days' AND v.user_id IN ${usersScope}
           UNION ALL
           SELECT DATE(v.claimed_at) AS d, 0::numeric AS issued, v.value::numeric AS claimed
           FROM vouchers v
           WHERE v.claimed_at >= NOW() - INTERVAL '${windowDays} days' AND v.user_id IN ${usersScope}
           UNION ALL
           SELECT DATE(lt.created_at) AS d, 0::numeric AS issued, ABS(lt.amount::numeric) AS claimed
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.created_at >= NOW() - INTERVAL '${windowDays} days'
             AND lt.type::text = 'admin_balance_adjustment'
             AND lt.metadata->>'kind' = 'voucher_removal'
             AND ${ledgerUserScope}
             AND NOT EXISTS (
               SELECT 1 FROM vouchers v2
               WHERE v2.id::text = lt.metadata->>'voucher_id'
             )
         ) x
         GROUP BY d`,
      ),
      queryMainRows<RefundRow[]>(
        `SELECT DATE(${fiatRefundAttributionTimestampSql("i")}) AS d,
           COALESCE(SUM(${fiatRefundCreditUsdSql("i")}), 0)::float8 AS refunds
         FROM fiat_deposit_intents i
         WHERE i.status IN ('partially_refunded', 'refunded')
           AND ${fiatRefundAttributionTimestampSql("i")} >= NOW() - INTERVAL '${windowDays} days'
           AND i.user_id IN ${usersScope}
         GROUP BY DATE(${fiatRefundAttributionTimestampSql("i")})`,
      ),
    ]);

    type Acc = {
      deposits: number;
      manualWd: number;
      cardWd: number;
      balanceChange: number;
      inventoryChange: number;
      voucherChange: number;
    };
    const byDay = new Map<string, Acc>();
    const dayKey = (d: Date) => new Date(d).toISOString().slice(0, 10);
    const acc = (k: string): Acc => {
      let a = byDay.get(k);
      if (!a) {
        a = {
          deposits: 0,
          manualWd: 0,
          cardWd: 0,
          balanceChange: 0,
          inventoryChange: 0,
          voucherChange: 0,
        };
        byDay.set(k, a);
      }
      return a;
    };

    for (const r of ledger) {
      const a = acc(dayKey(r.d));
      a.deposits += r.deposits;
      a.manualWd += r.manual_wd;
      a.balanceChange += r.balance_change;
    }
    for (const r of refunds) acc(dayKey(r.d)).deposits -= r.refunds;
    for (const r of card) acc(dayKey(r.d)).cardWd += r.card_wd;
    for (const r of inv)
      acc(dayKey(r.d)).inventoryChange += r.obtained - r.disposed;
    for (const r of vch)
      acc(dayKey(r.d)).voucherChange += r.issued - r.claimed;

    return [...byDay.entries()]
      .map(([date, a]) => ({
        date,
        // Exact per-day form of the windowed formula (manualWd carries its
        // stored sign here so the daily values sum to the windowed total).
        // Upgrader is fully covered by balanceChange (the ledger carries
        // both upgrader_bet debits and upgrader_payout credits); a prior
        // trailing upgraderWon term was based on a stale assumption that
        // the backend skipped upgrader_payout rows, which double-counted
        // every upgrader payout and produced ~$100k phantom loss bars.
        pnl:
          a.deposits -
          (a.manualWd + a.cardWd) -
          a.balanceChange -
          a.inventoryChange -
          a.voucherChange,
        deposits: a.deposits,
        // Gross money-out for the hover (clean positive regardless of how
        // the manual-withdrawal sign is stored).
        withdrawals: Math.abs(a.manualWd) + a.cardWd,
        // Already-derived windowed-delta components for the hover breakdown
        // — surfaced (not recomputed) so the tooltip can show where each
        // day's net deposit inflow actually went (balance / inventory /
        // voucher liability growth). These four terms + deposits −
        // withdrawals reconcile to `pnl` above by construction.
        balanceChange: a.balanceChange,
        inventoryChange: a.inventoryChange,
        voucherChange: a.voucherChange,
      }))
      .sort((x, y) => x.date.localeCompare(y.date));
  });
}

/**
 * Cached Daily-P&L wrapper. `getDailyPnl` is the heaviest uncached chart leg
 * (a 30-day lifetime scan across the ledger / inventory / voucher tables) and
 * was re-scanned on every 60s dashboard AutoRefresh, while every sibling chart
 * query (getTodayPnl, getAvgPnl7d, getDashboardStats) is already cached. This
 * mirrors those siblings exactly:
 *   • the excluded-users blacklist is resolved OUTSIDE unstable_cache and
 *     passed in as a serializable arg (getExcludedUserIds reads the admin DB,
 *     which can't run inside the cache scope), and
 *   • a UTC day key (YYYY-MM-DD) keeps the 30-day window fresh across the
 *     00:00-UTC rollover.
 * `revalidate: 300` per the audit; the served numbers are unchanged (identical
 * SQL, scope, and blacklist) — only the scan is memoized.
 */
const cachedDailyPnl = unstable_cache(
  async (
    dayKey: string,
    excluded: string[],
    days: DailyPnlWindowDays,
  ): Promise<DailyPnlPoint[]> => {
    void dayKey; // part of the cache key only (as is `days`, via the args)
    // (a throw degrades via the cache/safeQuery boundary, never re-runs the
    // heavy Postgres lifetime scan); `comparison` serves Postgres and logs
    // drift fire-and-forget; `off` serves Postgres. Cent/count-exact parity
    // confirmed (aligned-window harness: every field, every day Δ=0.00).
    return computeDailyPnl(excluded, days);
  },
  ["dashboard-daily-pnl-v3-refund-attribution"],
  { revalidate: 300, tags: ["dashboard-activity"] },
);

export async function getDailyPnl(
  days: DailyPnlWindowDays = 30,
): Promise<DailyPnlPoint[]> {
  const excluded = await getExcludedUserIds();
  // YYYY-MM-DD in UTC — rolls the cache at 00:00 UTC so the day-window
  // doesn't go stale; combined with the serialized blacklist arg and the
  // `days` arg (each window caches separately), the key refills when an
  // admin edits the excluded-users list.
  const dayKey = new Date().toISOString().slice(0, 10);
  return cachedDailyPnl(dayKey, excluded, days);
}

// ─── Pack & Battle Pure P&L (24h / 3d / 7d) ──────────────────────────
//
// Raw gameplay outcome for packs and battles ONLY. The "outcome" is
// what the house netted from gameplay alone:
//
//   pure_pnl = wager_in − cards_out
//
// where wager_in is the ledger amount on pack_opening / battle_bet /
// battle_sponsorship rows in the window, and cards_out is the value
// of inventory items the user obtained from those plays (source_type
// IN ('pack','battle') with obtained_at in the same window) PLUS the two
// ledger gaming-payout legs (GAMING_PAYOUT_TYPES — see
// src/lib/metrics/ledger-sets.ts): battle_excess_to_voucher (the voucher
// slice of a battle win the inventory card under-counts) AND battle_refund
// (the battle winner's CASH leg, never in inventory). Card values are
// taken at obtained_at — what they were worth the moment they entered the
// user's inventory.
//
// EXCLUDED on purpose: upgrader, bonuses, rakeback, affiliate
// commissions, rain prizes, race prizes, creator tips, gift / promo
// redemptions, voucher redemptions, balance rewards. (battle_excess_to_
// voucher and battle_refund are NOT rewards — they are part of the battle
// WIN payout, so they are included on the battle payout side; the excess
// voucher's later voucher_redeemed redemption stays neutral so the win is
// counted once.) This is the gambling outcome alone — every reward /
// discount surface is elsewhere. battlePayout = inventory(battle) +
// |battle_excess_to_voucher| + |battle_refund|, matching getGamingLegs.

export type PackBattlePnlRow = {
  // Wager + payout per game type. Wager comes from the ledger
  // (user's actual cash stake — the borrowed portion is NOT
  // included). Payouts come from user_inventory (the net value the
  // user kept after auto-resale of any borrowed portion). pnl =
  // wager − payouts, positive = house gained.
  packWager: number;
  packPayouts: number;
  packPnl: number;
  battleWager: number;
  battlePayouts: number;
  battlePnl: number;
  // Combined totals for the row totals at the top of the panel.
  totalWager: number;
  totalPayouts: number;
  totalPnl: number;
};

export type PackBattlePnlWindows = {
  h24: PackBattlePnlRow;
  d3: PackBattlePnlRow;
  d7: PackBattlePnlRow;
  // Lifetime row — no created_at lower bound. Useful as the headline
  // "all-time" pure margin alongside the rolling windows.
  all: PackBattlePnlRow;
};

/**
 * Inner compute for {@link getPackBattlePurePnl}. The resolved
 * excluded-users blacklist is passed in (rather than fetched here) so it
 * participates verbatim in the `unstable_cache` key of the public wrapper
 * below — `getExcludedUserIds` reads the admin DB, which cannot run inside
 * the cache scope. The SQL, scope, arithmetic, and returned numbers are
 * byte-for-byte identical to the previous body — the ONLY change is that
 * `excluded` arrives as an argument instead of being fetched inline.
 */
async function computePackBattlePurePnl(
  excluded: string[],
): Promise<PackBattlePnlWindows> {
  return withTiming("pnl.packBattlePure", async () => {
    const now = Date.now();
    const h24 = new Date(now - 24 * 60 * 60 * 1000);
    const d3 = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const blacklist = blacklistNotInClause("u.id", excluded);
    // Raw P&L scope: real customers ONLY. Creators are excluded
    // because their plays are house-funded promo / stream content;
    // counting them would inflate the wager side with money that
    // never came from a real customer.
    const scope = `user_id IN (SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklist})`;

    // Pre-computed filter fragments — kept as SQL strings so both the
    // ledger and inventory queries below stay consistent. Borrow plays
    // are excluded ENTIRELY (not just the borrowed leg): if a battle
    // had any borrow_percentage > 0 OR a pack open was tagged borrow,
    // both its wager row and its won inventory items drop out of the
    // Raw P&L numbers — admins want to see margin from real-money
    // plays only.
    const nonBorrowPackSessions = `(
      SELECT game_session_id FROM ledger_transactions
      WHERE type::text = 'pack_opening' AND status = 'completed'
        AND game_session_id IS NOT NULL
        AND (description IS NULL OR description NOT ILIKE '%borrow%')
    )`;
    const nonBorrowBattleSessions = `(
      SELECT bp.game_session_id FROM battle_participants bp
      JOIN battles b ON b.id = bp.battle_id
      WHERE COALESCE(b.borrow_percentage, 0) = 0
    )`;
    // Reward/daily-pack game_sessions (packs.pack_type='reward', price 0).
    // These $0-wager real-card giveaways are tracked as a reward cost in
    // /insights/rewards, so they are EXCLUDED from this pure gaming P&L on
    // BOTH sides (wager ≈$0; the won-card inventory is the material leg) —
    // aligning with the canonical getGamingLegs and the per-pack
    // insights-games/packs.ts edge (which already filters pack_type<>'reward').
    // Resolved via the same game_type='pack' → packs.pack_type='reward' join
    // daily-packs.ts uses.
    const rewardPackSessions = `(
      SELECT gs.id FROM game_sessions gs
      JOIN packs p ON p.id = gs.game_id AND p.pack_type = 'reward'
      WHERE gs.game_type = 'pack'
    )`;

    type LedgerRow = {
      pack_wager_h24: string; pack_wager_d3: string; pack_wager_d7: string; pack_wager_all: string;
      battle_wager_h24: string; battle_wager_d3: string; battle_wager_d7: string; battle_wager_all: string;
      // battle_excess_to_voucher — the voucher remainder of a battle win
      // the inventory card under-counts (see canonical metric layer
      // src/lib/metrics/ledger-sets.ts GAMING_PAYOUT_TYPES). Booked on the
      // ledger at battle settlement, so bucketed by created_at like the
      // wager legs. Added to the BATTLE payout side so this pure-PnL
      // captures the full win and reconciles with getGamingLegs.
      battle_excess_h24: string; battle_excess_d3: string; battle_excess_d7: string; battle_excess_all: string;
      // battle_refund — the battle winner's CASH leg (a separate ledger
      // gaming-payout row that is NOT in user_inventory). It is the other
      // half of GAMING_PAYOUT_TYPES alongside battle_excess_to_voucher.
      // Omitting it understated the battle payout by Σ|battle_refund| and
      // overstated house profit vs the canonical getGamingLegs. Bucketed
      // by created_at (settlement time) and summed unconditionally — like
      // battle_excess_to_voucher it carries no borrow flag of its own.
      battle_refund_h24: string; battle_refund_d3: string; battle_refund_d7: string; battle_refund_all: string;
    };
    type InvRow = {
      pack_payout_h24: string; pack_payout_d3: string; pack_payout_d7: string; pack_payout_all: string;
      battle_payout_h24: string; battle_payout_d3: string; battle_payout_d7: string; battle_payout_all: string;
    };

    // Two parallel queries — same staff + blacklist filter on both.
    // Ledger query reads the wager side (pack_opening + battle_bet
    // + battle_sponsorship) — only the user's actual cash stake,
    // NOT the borrowed portion. Inventory query reads the payout
    // side (cards the user keeps from a pack / battle session). On a
    // borrow play the inventory rows already reflect the net keep
    // after the borrowed portion is auto-resold to the house, so
    // pack/battle PnL reads raw user money in / raw user keep out —
    // ignoring the borrow leg entirely. All grouped by the four
    // windows (24h / 3d / 7d / all) via CASE.
    const [ledger, inv] = await Promise.all([
      queryMainRows<LedgerRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN type::text = 'pack_opening' AND created_at >= $1 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager_h24,
           COALESCE(SUM(CASE WHEN type::text = 'pack_opening' AND created_at >= $2 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager_d3,
           COALESCE(SUM(CASE WHEN type::text = 'pack_opening' AND created_at >= $3 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager_d7,
           COALESCE(SUM(CASE WHEN type::text = 'pack_opening'                                    THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager_all,
           COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') AND created_at >= $1 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager_h24,
           COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') AND created_at >= $2 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager_d3,
           COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') AND created_at >= $3 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager_d7,
           COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship')                                    THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager_all,
           -- battle_excess_to_voucher payout legs (battle-win remainder).
           -- Bucketed by created_at (settlement time). Summed
           -- unconditionally — like battle_refund in the canonical metric
           -- layer, it is a battle-settlement leg with no borrow flag of
           -- its own; the WHERE's borrow branch below passes it through.
           COALESCE(SUM(CASE WHEN type::text = 'battle_excess_to_voucher' AND created_at >= $1 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_excess_h24,
           COALESCE(SUM(CASE WHEN type::text = 'battle_excess_to_voucher' AND created_at >= $2 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_excess_d3,
           COALESCE(SUM(CASE WHEN type::text = 'battle_excess_to_voucher' AND created_at >= $3 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_excess_d7,
           COALESCE(SUM(CASE WHEN type::text = 'battle_excess_to_voucher'                                    THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_excess_all,
           -- battle_refund cash legs (battle winner's cash payout). Same
           -- created_at bucketing + unconditional sum as battle_excess
           -- (both are GAMING_PAYOUT_TYPES settlement legs, no borrow flag).
           COALESCE(SUM(CASE WHEN type::text = 'battle_refund' AND created_at >= $1 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund_h24,
           COALESCE(SUM(CASE WHEN type::text = 'battle_refund' AND created_at >= $2 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund_d3,
           COALESCE(SUM(CASE WHEN type::text = 'battle_refund' AND created_at >= $3 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund_d7,
           COALESCE(SUM(CASE WHEN type::text = 'battle_refund'                                    THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund_all
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text IN ('pack_opening','battle_bet','battle_sponsorship','battle_excess_to_voucher','battle_refund')
           AND ${scope}
           -- Borrow mode exclusion: drop pack opens tagged "borrow"
           -- in their description, and drop battle_bet wagers whose
           -- linked battle has any borrow_percentage > 0.
           -- battle_excess_to_voucher / battle_refund pass through
           -- unconditionally (they are battle-win settlement legs, not
           -- wager rows).
           --
           -- battle_sponsorship is counted DIRECTLY (no borrow gate) — its
           -- rows have game_session_id=NULL, so the non-borrow battle
           -- session IN-gate would drop every sponsorship row
           -- (NULL IN (...) => NULL => excluded), the bug that made this
           -- pure-PnL omit sponsorship while the dashboard wager tile
           -- counted it. All sponsored battles are borrow_percentage=0
           -- (owner-confirmed), so no gate is needed.
           --
           -- Reward/daily packs (packs.pack_type='reward') are excluded
           -- from the pack wager (≈$0 anyway) — a giveaway tracked as a
           -- reward cost, not gaming. Fix mirrors getGamingLegs.
           AND (
             (type::text = 'pack_opening'
              AND (description IS NULL OR description NOT ILIKE '%borrow%')
              AND (game_session_id IS NULL OR game_session_id NOT IN ${rewardPackSessions}))
             OR (type::text = 'battle_bet' AND game_session_id IN ${nonBorrowBattleSessions})
             OR type::text = 'battle_sponsorship'
             OR type::text = 'battle_excess_to_voucher'
             OR type::text = 'battle_refund'
           )`,
        h24, d3, d7,
      ),
      queryMainRows<InvRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN source_type = 'pack' AND obtained_at >= $1 THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS pack_payout_h24,
           COALESCE(SUM(CASE WHEN source_type = 'pack' AND obtained_at >= $2 THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS pack_payout_d3,
           COALESCE(SUM(CASE WHEN source_type = 'pack' AND obtained_at >= $3 THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS pack_payout_d7,
           COALESCE(SUM(CASE WHEN source_type = 'pack'                                    THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS pack_payout_all,
           COALESCE(SUM(CASE WHEN source_type = 'battle' AND obtained_at >= $1 THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS battle_payout_h24,
           COALESCE(SUM(CASE WHEN source_type = 'battle' AND obtained_at >= $2 THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS battle_payout_d3,
           COALESCE(SUM(CASE WHEN source_type = 'battle' AND obtained_at >= $3 THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS battle_payout_d7,
           COALESCE(SUM(CASE WHEN source_type = 'battle'                                    THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS battle_payout_all
         FROM user_inventory
         WHERE source_type IN ('pack','battle')
           AND ${scope}
           -- Drop inventory rows from borrow plays so the payout side
           -- matches the wager-side exclusion. source_id is the
           -- game_session_id when source_type IN ('pack','battle').
           AND (
             (source_type = 'pack' AND source_id IN ${nonBorrowPackSessions})
             OR (source_type = 'battle' AND source_id IN ${nonBorrowBattleSessions})
           )
           -- Fix 2: exclude won-card inventory from reward/daily-pack opens
           -- (keyed on source_id = originating game_session_id). The
           -- giveaway is a reward cost, not a gaming payout — counting it
           -- here would double-count it and show the pack as a straight
           -- loss. ('reward' source_type rows never enter this leg — it
           -- filters source_type IN ('pack','battle') — so this drops the
           -- 'pack'-typed reward cards; mirrors getGamingLegs.)
           AND (source_id IS NULL OR source_id NOT IN ${rewardPackSessions})`,
        h24, d3, d7,
      ),
    ]);

    const l = ledger[0] ?? {
      pack_wager_h24: "0", pack_wager_d3: "0", pack_wager_d7: "0", pack_wager_all: "0",
      battle_wager_h24: "0", battle_wager_d3: "0", battle_wager_d7: "0", battle_wager_all: "0",
      battle_excess_h24: "0", battle_excess_d3: "0", battle_excess_d7: "0", battle_excess_all: "0",
      battle_refund_h24: "0", battle_refund_d3: "0", battle_refund_d7: "0", battle_refund_all: "0",
    };
    const i = inv[0] ?? {
      pack_payout_h24: "0", pack_payout_d3: "0", pack_payout_d7: "0", pack_payout_all: "0",
      battle_payout_h24: "0", battle_payout_d3: "0", battle_payout_d7: "0", battle_payout_all: "0",
    };

    const buildRow = (
      packWagerKey: keyof LedgerRow,
      battleWagerKey: keyof LedgerRow,
      packPayoutKey: keyof InvRow,
      battlePayoutKey: keyof InvRow,
      battleExcessKey: keyof LedgerRow,
      battleRefundKey: keyof LedgerRow,
    ): PackBattlePnlRow => {
      const packWager = toNumber(l[packWagerKey]);
      const battleWager = toNumber(l[battleWagerKey]);
      // Payouts = the NET value of cards the user keeps. On a borrow
      // play the borrowed portion is auto-resold to the house before
      // the inventory row materializes, so value_at_obtained on the
      // surviving rows already reflects user-net-keep (not the gross
      // pull).
      //
      // BATTLE payout additionally includes the two ledger gaming-payout
      // legs (GAMING_PAYOUT_TYPES): battle_excess_to_voucher AND
      // battle_refund. A battle win's expected_value = card_value +
      // voucher_value, but the inventory row's value_at_obtained records
      // ONLY the card; the voucher remainder is booked at settlement as
      // battle_excess_to_voucher and the winner's cash leg as
      // battle_refund. Both COMPLETE the win and are NOT a double-count
      // (the inventory under-counts by exactly these slices; battle_refund
      // is a cash leg never in inventory). The later voucher_redeemed
      // redemption of the excess voucher is NEUTRAL (see
      // src/lib/metrics/ledger-sets.ts), so the win is counted once. This
      // makes battlePayouts reconcile with getGamingLegs.
      const packPayouts = toNumber(i[packPayoutKey]);
      const battlePayouts =
        toNumber(i[battlePayoutKey]) +
        toNumber(l[battleExcessKey]) +
        toNumber(l[battleRefundKey]);
      const packPnl = packWager - packPayouts;
      const battlePnl = battleWager - battlePayouts;
      return {
        packWager,
        packPayouts,
        packPnl,
        battleWager,
        battlePayouts,
        battlePnl,
        totalWager: packWager + battleWager,
        totalPayouts: packPayouts + battlePayouts,
        totalPnl: packPnl + battlePnl,
      };
    };

    return {
      h24: buildRow("pack_wager_h24", "battle_wager_h24", "pack_payout_h24", "battle_payout_h24", "battle_excess_h24", "battle_refund_h24"),
      d3:  buildRow("pack_wager_d3",  "battle_wager_d3",  "pack_payout_d3",  "battle_payout_d3",  "battle_excess_d3",  "battle_refund_d3"),
      d7:  buildRow("pack_wager_d7",  "battle_wager_d7",  "pack_payout_d7",  "battle_payout_d7",  "battle_excess_d7",  "battle_refund_d7"),
      all: buildRow("pack_wager_all", "battle_wager_all", "pack_payout_all", "battle_payout_all", "battle_excess_all", "battle_refund_all"),
    };
  });
}

/**
 * Cross-request cache for the {@link getPackBattlePurePnl} pure-margin
 * scan. This is the `pure_pnl` surface, rendered on BOTH the Overview and
 * Raw P&L tabs, with an UNBOUNDED all-time window (the `*_all` legs scan
 * the full ledger + inventory with no `created_at` lower bound) — it was
 * re-scanned on every 5-minute `AutoRefresh` tick and per viewer with no
 * cache. The result is period-independent (the four windows are always
 * computed together), so ONE cache key suffices; it is keyed only on the
 * sorted excluded-users blacklist (resolved OUTSIDE the cache — the admin
 * DB can't be read inside the cache scope) so an admin edit to that list
 * busts stale numbers on the next tick. 300s per the audit; the served
 * numbers are unchanged (identical SQL, scope, and blacklist) — only the
 * scan is memoized. Mirrors `cachedDailyPnl` above.
 */
const cachedPackBattlePurePnl = unstable_cache(
  computePackBattlePurePnl,
  ["pnl-pack-battle-pure-v1"],
  { revalidate: 300, tags: ["dashboard-activity"] },
);

export async function getPackBattlePurePnl(): Promise<PackBattlePnlWindows> {
  const excluded = await getExcludedUserIds();
  return cachedPackBattlePurePnl([...excluded].sort());
}
