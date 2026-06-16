import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getDailyPnlFromClickHouse } from "@/lib/clickhouse/queries/dashboard/daily-pnl";
import { compareDashboardDailyPnl } from "@/lib/clickhouse/compare/dashboard-daily-pnl";
import { blacklistNotInClause } from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  officialStreamAdjustmentPrismaWhere,
  removeLockedBalanceAdjustmentPrismaWhere,
  statsExcludedAdjustmentSqlPredicate,
} from "@/lib/balance-adjustment-categories";

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
 * `withdrawals`    = balances.total_withdrawn (legacy ledger withdrawals) +
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
 * card/crypto withdrawals (it stayed 0 across the snapshot while
 * completed withdrawals existed) — there is no `card_withdrawal` ledger
 * type, so the request's `total_value_usd` is the sole record of the
 * outflow.
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
    const db = await getDb();
    const [
      balances,
      cardWithdrawals,
      inventoryAgg,
      vouchersAgg,
      officialStreamAgg,
      removeLockedAgg,
    ] = await Promise.all([
        db.balances.findUnique({
          where: { user_id: userId },
          select: {
            available_balance: true,
            locked_balance: true,
            total_deposited: true,
            total_withdrawn: true,
          },
        }),
        db.card_withdrawal_requests.aggregate({
          where: {
            user_id: userId,
            // In-flight (pending/processing) + done (shipped/completed)
            // all count as a house liability — see
            // WITHDRAWAL_LIABILITY_STATUSES. Pending/processing value is
            // locked inventory excluded below, so counting it here is the
            // only place it appears (no double-count) and keeps the P&L
            // continuous when a withdrawal completes.
            status: { in: [...WITHDRAWAL_LIABILITY_STATUSES] },
          },
          _sum: { total_value_usd: true },
        }),
        db.user_inventory.aggregate({
          where: {
            user_id: userId,
            sold_at: null,
            exchanged_at: null,
            // Cards locked for an in-flight withdrawal have effectively
            // left the user's holdings — their value is carried by the
            // `withdrawals` term above instead (pending/processing count
            // there). Excluding them here avoids double-counting and keeps
            // the User Detail / Users List PnL aligned with the dashboard's
            // totalInventoryValue aggregate (which filters the same way).
            withdrawal_locked_at: null,
          },
          _sum: { value_at_obtained: true },
        }),
        db.vouchers.aggregate({
          where: { user_id: userId, claimed_at: null },
          _sum: { value: true },
        }),
        // FAKE-BALANCE carve-out: SIGNED NET of this user's completed
        // official_stream adjustments. They credit REAL available_balance
        // but are owner-designated fake balance, so subtract them from the
        // onSiteBalance term below. NET (`_sum.amount`, not ABS) so a later
        // clawback debit reverses a prior credit. MUST match
        // calculateUsersPnlBatch so users-list == user-detail.
        db.ledger_transactions.aggregate({
          where: {
            user_id: userId,
            status: "completed",
            ...officialStreamAdjustmentPrismaWhere(),
          },
          _sum: { amount: true },
        }),
        // REMOVE-LOCKED carve-out: SIGNED NET of completed remove_locked_balance
        // adjustments. Locked_balance drops in the raw balance row, so subtract
        // the signed ledger amount to keep onSiteBalance / P&L unchanged.
        db.ledger_transactions.aggregate({
          where: {
            user_id: userId,
            status: "completed",
            ...removeLockedBalanceAdjustmentPrismaWhere(),
          },
          _sum: { amount: true },
        }),
      ]);

    const components: PnlComponents = {
      deposits: toNumber(balances?.total_deposited),
      withdrawals:
        toNumber(balances?.total_withdrawn) +
        toNumber(cardWithdrawals._sum.total_value_usd),
      onSiteBalance:
        toNumber(balances?.available_balance) +
        toNumber(balances?.locked_balance) -
        // Net out fake-balance official_stream credit.
        toNumber(officialStreamAgg._sum.amount) -
        // Net out remove_locked_balance debits (signed; amounts are negative).
        toNumber(removeLockedAgg._sum.amount),
      inventoryValue: toNumber(inventoryAgg._sum.value_at_obtained),
      unclaimedVouchers: toNumber(vouchersAgg._sum.value),
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
export async function calculateWindowedPnl(opts: {
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
}): Promise<WindowedPnl> {
  const { since, userId, excludeUserIds = [], populationScopeSql } = opts;
  return withTiming("pnl.windowed", async () => {
    const db = await getDb();

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
    const statsExcluded = statsExcludedAdjustmentSqlPredicate({
      typeColumn: "lt.type",
      metadataColumn: "lt.metadata",
    });
    const userScopeLt = scope("lt.user_id");

    type LedgerRow = { deposits: string; manual_wd: string; balance_change: string };
    type CardRow = { card_wd: string };
    type InvRow = { obtained: string; disposed: string };
    type VchRow = { issued: string; claimed: string };

    const [ledger, card, inv, vch] = await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::text AS deposits,
           COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                              AND lt.balance_after < lt.balance_before
                              AND lt.description ILIKE 'Manual withdrawal:%'
                             THEN lt.amount::numeric ELSE 0 END), 0)::text AS manual_wd,
           COALESCE(SUM(CASE WHEN ${statsExcluded} THEN 0 ELSE (lt.balance_after - lt.balance_before)::numeric END), 0)::text AS balance_change
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND lt.created_at >= $1 AND ${userScopeLt}`,
        ...params,
      ),
      db.$queryRawUnsafe<CardRow[]>(
        `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS card_wd
         FROM card_withdrawal_requests cwr
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $1
           AND ${scope("cwr.user_id")}`,
        ...params,
      ),
      db.$queryRawUnsafe<InvRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN ui.obtained_at >= $1 THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS obtained,
           (
             COALESCE(SUM(CASE WHEN (ui.sold_at >= $1 OR ui.exchanged_at >= $1) THEN ui.value_at_obtained::numeric ELSE 0 END), 0)
             + ${adminInventoryRemovalDisposedSql("$1", userScopeLt)}
           )::text AS disposed
         FROM user_inventory ui
         WHERE (ui.obtained_at >= $1 OR ui.sold_at >= $1 OR ui.exchanged_at >= $1)
           AND ${scope("ui.user_id")}`,
        ...params,
      ),
      db.$queryRawUnsafe<VchRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN v.created_at >= $1 THEN v.value::numeric ELSE 0 END), 0)::text AS issued,
           (
             COALESCE(SUM(CASE WHEN v.claimed_at >= $1 THEN v.value::numeric ELSE 0 END), 0)
             + ${adminVoucherRemovalClaimedSql("$1", userScopeLt)}
           )::text AS claimed
         FROM vouchers v
         WHERE (v.created_at >= $1 OR v.claimed_at >= $1)
           AND ${scope("v.user_id")}`,
        ...params,
      ),
    ]);

    const deposits = toNumber(ledger[0]?.deposits);
    const manualWd = toNumber(ledger[0]?.manual_wd);
    const cardWd = toNumber(card[0]?.card_wd);
    const withdrawalsGross = Math.abs(manualWd) + cardWd;
    const balanceChange = toNumber(ledger[0]?.balance_change);
    const inventoryChange =
      toNumber(inv[0]?.obtained) - toNumber(inv[0]?.disposed);
    const voucherChange = toNumber(vch[0]?.issued) - toNumber(vch[0]?.claimed);
    // Upgrader payouts are fully captured by `balanceChange` — the
    // ledger carries both upgrader_bet (debit) and upgrader_payout
    // (credit) rows, so no separate `upgrader_games` correction is
    // needed here. A prior trailing term was based on a stale
    // assumption that the backend never wrote upgrader_payout rows;
    // that double-subtracted every upgrader win and inflated the
    // surfaced house loss.
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
    const db = await getDb();
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

    const [ledger, card, inv, adminInv, vchIssued, vchClaimed, adminVch] =
      await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
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
      db.$queryRawUnsafe<AmountRow[]>(
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
      db.$queryRawUnsafe<InvRow[]>(
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
      db.$queryRawUnsafe<AmountRow[]>(
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
      db.$queryRawUnsafe<AmountRow[]>(
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
      db.$queryRawUnsafe<AmountRow[]>(
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
      db.$queryRawUnsafe<AmountRow[]>(
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
    ]);

    const ledgerByUser = new Map(ledger.map((r) => [r.user_id, r]));
    const cardByUser = new Map(card.map((r) => [r.user_id, r]));
    const invByUser = new Map(inv.map((r) => [r.user_id, r]));
    const adminInvByUser = new Map(adminInv.map((r) => [r.user_id, r]));
    const vchIssuedByUser = new Map(vchIssued.map((r) => [r.user_id, r]));
    const vchClaimedByUser = new Map(vchClaimed.map((r) => [r.user_id, r]));
    const adminVchByUser = new Map(adminVch.map((r) => [r.user_id, r]));

    for (const userId of userIds) {
      const lt = ledgerByUser.get(userId);
      const deposits = toNumber(lt?.deposits);
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
    const db = await getDb();
    const [
      balanceRows,
      cardWithdrawalRows,
      inventoryRows,
      voucherRows,
      officialStreamRows,
      removeLockedRows,
    ] = await Promise.all([
        db.balances.findMany({
          where: { user_id: { in: userIds } },
          select: {
            user_id: true,
            available_balance: true,
            locked_balance: true,
            total_deposited: true,
            total_withdrawn: true,
          },
        }),
        db.card_withdrawal_requests.groupBy({
          by: ["user_id"],
          where: {
            user_id: { in: userIds },
            // Same in-flight + done liability set as calculateUserPnl so
            // the users-LIST P&L matches the user-DETAIL P&L.
            status: { in: [...WITHDRAWAL_LIABILITY_STATUSES] },
          },
          _sum: { total_value_usd: true },
        }),
        db.user_inventory.groupBy({
          by: ["user_id"],
          where: {
            user_id: { in: userIds },
            sold_at: null,
            exchanged_at: null,
            // M10: apply the SAME withdrawal-lock exclusion calculateUserPnl
            // uses, so locked-for-withdrawal cards drop out of LIST
            // inventory exactly as they do on DETAIL. Their value is
            // carried by the withdrawals term above (pending/processing are
            // counted there), so it appears exactly once — list PnL now
            // equals detail PnL.
            withdrawal_locked_at: null,
          },
          _sum: { value_at_obtained: true },
        }),
        db.vouchers.groupBy({
          by: ["user_id"],
          where: { user_id: { in: userIds }, claimed_at: null },
          _sum: { value: true },
        }),
        // FAKE-BALANCE carve-out: per-user SIGNED NET of completed
        // official_stream adjustments (groupBy user_id). MUST mirror the
        // single-user calculateUserPnl exactly so the users-LIST P&L equals
        // the user-DETAIL P&L. NET (`_sum.amount`) so a clawback reverses it.
        db.ledger_transactions.groupBy({
          by: ["user_id"],
          where: {
            user_id: { in: userIds },
            status: "completed",
            ...officialStreamAdjustmentPrismaWhere(),
          },
          _sum: { amount: true },
        }),
        db.ledger_transactions.groupBy({
          by: ["user_id"],
          where: {
            user_id: { in: userIds },
            status: "completed",
            ...removeLockedBalanceAdjustmentPrismaWhere(),
          },
          _sum: { amount: true },
        }),
      ]);

    const balanceMap = new Map(balanceRows.map((b) => [b.user_id, b]));
    const cardWithdrawalMap = new Map(
      cardWithdrawalRows.map((cw) => [
        cw.user_id,
        toNumber(cw._sum.total_value_usd),
      ]),
    );
    const inventoryMap = new Map(
      inventoryRows.map((iv) => [iv.user_id, toNumber(iv._sum.value_at_obtained)]),
    );
    const voucherMap = new Map(
      voucherRows.map((v) => [v.user_id, toNumber(v._sum.value)]),
    );
    const officialStreamMap = new Map(
      officialStreamRows.map((o) => [o.user_id, toNumber(o._sum.amount)]),
    );
    const removeLockedMap = new Map(
      removeLockedRows.map((o) => [o.user_id, toNumber(o._sum.amount)]),
    );

    for (const userId of userIds) {
      const b = balanceMap.get(userId);
      const components: PnlComponents = {
        deposits: toNumber(b?.total_deposited),
        withdrawals:
          toNumber(b?.total_withdrawn) + (cardWithdrawalMap.get(userId) ?? 0),
        onSiteBalance:
          toNumber(b?.available_balance) +
          toNumber(b?.locked_balance) -
          // Net out fake-balance official_stream credit (matches detail).
          (officialStreamMap.get(userId) ?? 0) -
          (removeLockedMap.get(userId) ?? 0),
        inventoryValue: inventoryMap.get(userId) ?? 0,
        unclaimedVouchers: voucherMap.get(userId) ?? 0,
      };
      result.set(userId, { ...components, pnl: computeHousePnl(components) });
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
 * Daily house P&L for the last 30 days — the per-day breakdown of the same
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
async function computeDailyPnl(excluded: string[]): Promise<DailyPnlPoint[]> {
  return withTiming("pnl.daily", async () => {
    const db = await getDb();
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
    type CardRow = { d: Date; card_wd: number };
    type InvRow = { d: Date; obtained: number; disposed: number };
    type VchRow = { d: Date; issued: number; claimed: number };

    const [ledger, card, inv, vch] = await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
        `SELECT DATE(lt.created_at) AS d,
           COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS deposits,
           COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                              AND lt.balance_after < lt.balance_before
                              AND lt.description ILIKE 'Manual withdrawal:%'
                             THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS manual_wd,
           COALESCE(SUM(CASE WHEN ${statsExcluded} THEN 0 ELSE (lt.balance_after - lt.balance_before)::numeric END), 0)::float8 AS balance_change
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND lt.created_at >= NOW() - INTERVAL '30 days'
           AND lt.user_id IN ${usersScope}
         GROUP BY DATE(lt.created_at)`,
      ),
      db.$queryRawUnsafe<CardRow[]>(
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
           AND COALESCE(cwr.shipped_at, cwr.completed_at) >= NOW() - INTERVAL '30 days'
           AND cwr.user_id IN ${usersScope}
         GROUP BY DATE(COALESCE(cwr.shipped_at, cwr.completed_at))`,
      ),
      db.$queryRawUnsafe<InvRow[]>(
        `SELECT d,
           COALESCE(SUM(obtained), 0)::float8 AS obtained,
           COALESCE(SUM(disposed), 0)::float8 AS disposed
         FROM (
           SELECT DATE(ui.obtained_at) AS d, ui.value_at_obtained::numeric AS obtained, 0::numeric AS disposed
           FROM user_inventory ui
           WHERE ui.obtained_at >= NOW() - INTERVAL '30 days' AND ui.user_id IN ${usersScope}
           UNION ALL
           SELECT DATE(COALESCE(ui.sold_at, ui.exchanged_at)) AS d, 0::numeric AS obtained, ui.value_at_obtained::numeric AS disposed
           FROM user_inventory ui
           WHERE (ui.sold_at >= NOW() - INTERVAL '30 days' OR ui.exchanged_at >= NOW() - INTERVAL '30 days')
             AND ui.user_id IN ${usersScope}
           UNION ALL
           SELECT DATE(lt.created_at) AS d, 0::numeric AS obtained, ABS(lt.amount::numeric) AS disposed
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.created_at >= NOW() - INTERVAL '30 days'
             AND lt.type::text = 'admin_balance_adjustment'
             AND lt.metadata->>'kind' = 'inventory_removal'
             AND ${ledgerUserScope}
             AND NOT EXISTS (
               SELECT 1 FROM user_inventory ui2
               WHERE ui2.id::text = lt.metadata->>'inventory_item_id'
             )
         ) x
         GROUP BY d`,
      ),
      db.$queryRawUnsafe<VchRow[]>(
        `SELECT d,
           COALESCE(SUM(issued), 0)::float8 AS issued,
           COALESCE(SUM(claimed), 0)::float8 AS claimed
         FROM (
           SELECT DATE(v.created_at) AS d, v.value::numeric AS issued, 0::numeric AS claimed
           FROM vouchers v
           WHERE v.created_at >= NOW() - INTERVAL '30 days' AND v.user_id IN ${usersScope}
           UNION ALL
           SELECT DATE(v.claimed_at) AS d, 0::numeric AS issued, v.value::numeric AS claimed
           FROM vouchers v
           WHERE v.claimed_at >= NOW() - INTERVAL '30 days' AND v.user_id IN ${usersScope}
           UNION ALL
           SELECT DATE(lt.created_at) AS d, 0::numeric AS issued, ABS(lt.amount::numeric) AS claimed
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.created_at >= NOW() - INTERVAL '30 days'
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
  async (dayKey: string, excluded: string[]): Promise<DailyPnlPoint[]> => {
    void dayKey; // part of the cache key only
    // CQRS serve-path: in `clickhouse` mode the CH twin is the SOLE read
    // (a throw degrades via the cache/safeQuery boundary, never re-runs the
    // heavy Postgres lifetime scan); `comparison` serves Postgres and logs
    // drift fire-and-forget; `off` serves Postgres. Cent/count-exact parity
    // confirmed (aligned-window harness: every field, every day Δ=0.00).
    return resolveAdminRead<DailyPnlPoint[]>("dashboard_daily_pnl", {
      pg: () => computeDailyPnl(excluded),
      ch: () => getDailyPnlFromClickHouse(excluded),
      compare: (pg) => {
        void compareDashboardDailyPnl(pg);
      },
    });
  },
  ["dashboard-daily-pnl-v1"],
  { revalidate: 300, tags: ["dashboard-activity"] },
);

export async function getDailyPnl(): Promise<DailyPnlPoint[]> {
  const excluded = await getExcludedUserIds();
  // YYYY-MM-DD in UTC — rolls the cache at 00:00 UTC so the 30-day window
  // doesn't go stale; combined with the serialized blacklist arg, the key
  // refills when an admin edits the excluded-users list.
  const dayKey = new Date().toISOString().slice(0, 10);
  return cachedDailyPnl(dayKey, excluded);
}

// ─── Period P&L breakdown (24h / 3d / 7d) ────────────────────────────
//
// Windowed P&L per window using the same formula as calculateWindowedPnl
//   pnl = deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ
// PLUS a "payout breakdown" showing how much was paid out via each
// major category (rain prizes, creator tips, race prizes, leaderboard
// prizes, rakeback, affiliate, gift/promo, bonuses, card sales, battle
// refunds). The payout rows are INFORMATIONAL — they're subsets of the
// balance Δ already accounted for in the formula above (so they don't
// add to the total).
//
// One ledger query GROUP BY type with CASE-per-window does all three
// windows at once; card-withdrawals / inventory / vouchers run in
// parallel with their own three-window CASE aggregations.

export type PnlBreakdownRow = {
  // P&L formula components — these sum to `total`.
  deposits: number;
  withdrawals: number;
  balanceDelta: number;
  inventoryDelta: number;
  voucherDelta: number;
  total: number;
  // Payout breakdown (informational; already inside balanceDelta).
  rainPrizes: number;
  creatorTips: number;
  racePrizes: number;
  leaderboardPrizes: number;
  rakebackClaims: number;
  affiliateClaims: number;
  giftPromoVoucher: number;
  bonuses: number;
  cardSalesExchanges: number;
  battleRefundsExcess: number;
  upgraderPayouts: number;
};

export type PnlBreakdownWindows = {
  h24: PnlBreakdownRow;
  d3: PnlBreakdownRow;
  d7: PnlBreakdownRow;
};

// Which ledger types belong to which payout category. Each category sums
// the POSITIVE balance delta (credits) for its types — i.e. how much
// the house paid out to users via that surface. Sender/receiver types
// (like creator_tip) only count the receiver-side credits this way.
const PAYOUT_CATEGORY_TYPES = {
  rainPrizes: ["rain_win"],
  creatorTips: ["creator_tip"],
  racePrizes: ["race_prize"],
  leaderboardPrizes: ["affiliate_leaderboard_prize"],
  rakebackClaims: ["rakeback_claim"],
  affiliateClaims: ["affiliate_claim"],
  giftPromoVoucher: [
    "gift_card_redeemed",
    "promo_code_redeemed",
    "voucher_redeemed",
  ],
  bonuses: ["deposit_bonus", "balance_reward_claim", "waitlist_prize"],
  cardSalesExchanges: [
    "card_sale",
    "reward_card_sale",
    "card_exchange",
    "voucher_exchange",
    "exchange_excess_credit",
  ],
  battleRefundsExcess: [
    "battle_refund",
    "battle_excess_to_voucher",
    "exchange_excess_to_voucher",
  ],
  upgraderPayouts: ["upgrader_payout"],
} as const;

type PayoutCategoryKey = keyof typeof PAYOUT_CATEGORY_TYPES;

export async function getPnlBreakdownWindows(): Promise<PnlBreakdownWindows> {
  return withTiming("pnl.breakdownWindows", async () => {
    const db = await getDb();
    const now = Date.now();
    const h24 = new Date(now - 24 * 60 * 60 * 1000);
    const d3 = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const excluded = await getExcludedUserIds();
    const blacklist = blacklistNotInClause("u.id", excluded);
    // Real-user scope used identically in every query below.
    const scope = `user_id IN (SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support') ${blacklist})`;
    const statsExcluded = statsExcludedAdjustmentSqlPredicate();

    type LedgerRow = {
      type: string;
      cr_h24: string; cr_d3: string; cr_d7: string;
      dl_h24: string; dl_d3: string; dl_d7: string;
      mwd_h24: string; mwd_d3: string; mwd_d7: string;
    };
    type CardWdRow = { cwd_h24: string; cwd_d3: string; cwd_d7: string };
    type InvRow = {
      obt_h24: string; obt_d3: string; obt_d7: string;
      dis_h24: string; dis_d3: string; dis_d7: string;
    };
    type VchRow = {
      iss_h24: string; iss_d3: string; iss_d7: string;
      clm_h24: string; clm_d3: string; clm_d7: string;
    };

    // cr_* = credits (positive balance deltas only — "money out to users").
    // dl_* = signed balance delta (used to compute the formula's balanceΔ).
    // mwd_* = manual-withdrawal admin adjustments (subset of
    //         admin_balance_adjustment); only non-zero on the
    //         admin_balance_adjustment row in the grouped result.
    const [ledger, cardWd, inv, vch, adminInvRem, adminVchRem] = await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
        `SELECT type,
           COALESCE(SUM(CASE WHEN created_at >= $1 THEN GREATEST(balance_after - balance_before, 0)::numeric ELSE 0 END), 0)::text AS cr_h24,
           COALESCE(SUM(CASE WHEN created_at >= $2 THEN GREATEST(balance_after - balance_before, 0)::numeric ELSE 0 END), 0)::text AS cr_d3,
           COALESCE(SUM(CASE WHEN created_at >= $3 THEN GREATEST(balance_after - balance_before, 0)::numeric ELSE 0 END), 0)::text AS cr_d7,
           COALESCE(SUM(CASE WHEN created_at >= $1 AND NOT (${statsExcluded}) THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS dl_h24,
           COALESCE(SUM(CASE WHEN created_at >= $2 AND NOT (${statsExcluded}) THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS dl_d3,
           COALESCE(SUM(CASE WHEN created_at >= $3 AND NOT (${statsExcluded}) THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS dl_d7,
           COALESCE(SUM(CASE WHEN created_at >= $1 AND type::text = 'admin_balance_adjustment' AND balance_after < balance_before AND description ILIKE 'Manual withdrawal:%' THEN amount::numeric ELSE 0 END), 0)::text AS mwd_h24,
           COALESCE(SUM(CASE WHEN created_at >= $2 AND type::text = 'admin_balance_adjustment' AND balance_after < balance_before AND description ILIKE 'Manual withdrawal:%' THEN amount::numeric ELSE 0 END), 0)::text AS mwd_d3,
           COALESCE(SUM(CASE WHEN created_at >= $3 AND type::text = 'admin_balance_adjustment' AND balance_after < balance_before AND description ILIKE 'Manual withdrawal:%' THEN amount::numeric ELSE 0 END), 0)::text AS mwd_d7
         FROM ledger_transactions
         WHERE status = 'completed' AND created_at >= $3 AND ${scope}
         GROUP BY type`,
        h24, d3, d7,
      ),
      db.$queryRawUnsafe<CardWdRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN COALESCE(shipped_at, completed_at) >= $1 THEN total_value_usd::numeric ELSE 0 END), 0)::text AS cwd_h24,
           COALESCE(SUM(CASE WHEN COALESCE(shipped_at, completed_at) >= $2 THEN total_value_usd::numeric ELSE 0 END), 0)::text AS cwd_d3,
           COALESCE(SUM(CASE WHEN COALESCE(shipped_at, completed_at) >= $3 THEN total_value_usd::numeric ELSE 0 END), 0)::text AS cwd_d7
         FROM card_withdrawal_requests
         WHERE status IN ('completed', 'shipped')
           AND COALESCE(shipped_at, completed_at) >= $3
           AND ${scope}`,
        h24, d3, d7,
      ),
      db.$queryRawUnsafe<InvRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN obtained_at >= $1 THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS obt_h24,
           COALESCE(SUM(CASE WHEN obtained_at >= $2 THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS obt_d3,
           COALESCE(SUM(CASE WHEN obtained_at >= $3 THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS obt_d7,
           COALESCE(SUM(CASE WHEN (sold_at >= $1 OR exchanged_at >= $1) THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS dis_h24,
           COALESCE(SUM(CASE WHEN (sold_at >= $2 OR exchanged_at >= $2) THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS dis_d3,
           COALESCE(SUM(CASE WHEN (sold_at >= $3 OR exchanged_at >= $3) THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS dis_d7
         FROM user_inventory
         WHERE (obtained_at >= $3 OR sold_at >= $3 OR exchanged_at >= $3)
           AND ${scope}`,
        h24, d3, d7,
      ),
      db.$queryRawUnsafe<VchRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN created_at >= $1 THEN value::numeric ELSE 0 END), 0)::text AS iss_h24,
           COALESCE(SUM(CASE WHEN created_at >= $2 THEN value::numeric ELSE 0 END), 0)::text AS iss_d3,
           COALESCE(SUM(CASE WHEN created_at >= $3 THEN value::numeric ELSE 0 END), 0)::text AS iss_d7,
           COALESCE(SUM(CASE WHEN claimed_at >= $1 THEN value::numeric ELSE 0 END), 0)::text AS clm_h24,
           COALESCE(SUM(CASE WHEN claimed_at >= $2 THEN value::numeric ELSE 0 END), 0)::text AS clm_d3,
           COALESCE(SUM(CASE WHEN claimed_at >= $3 THEN value::numeric ELSE 0 END), 0)::text AS clm_d7
         FROM vouchers
         WHERE (created_at >= $3 OR claimed_at >= $3)
           AND ${scope}`,
        h24, d3, d7,
      ),
      db.$queryRawUnsafe<InvRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN lt.created_at >= $1 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS dis_h24,
           COALESCE(SUM(CASE WHEN lt.created_at >= $2 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS dis_d3,
           COALESCE(SUM(CASE WHEN lt.created_at >= $3 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS dis_d7
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $3
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.metadata->>'kind' = 'inventory_removal'
           AND ${scope.replace(/user_id/g, "lt.user_id")}
           AND NOT EXISTS (
             SELECT 1 FROM user_inventory ui2
             WHERE ui2.id::text = lt.metadata->>'inventory_item_id'
           )`,
        h24, d3, d7,
      ),
      db.$queryRawUnsafe<VchRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN lt.created_at >= $1 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS clm_h24,
           COALESCE(SUM(CASE WHEN lt.created_at >= $2 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS clm_d3,
           COALESCE(SUM(CASE WHEN lt.created_at >= $3 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS clm_d7
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $3
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.metadata->>'kind' = 'voucher_removal'
           AND ${scope.replace(/user_id/g, "lt.user_id")}
           AND NOT EXISTS (
             SELECT 1 FROM vouchers v2
             WHERE v2.id::text = lt.metadata->>'voucher_id'
           )`,
        h24, d3, d7,
      ),
    ]);

    // Build per-window aggregates.
    const windows: Array<{
      key: "h24" | "d3" | "d7";
      crKey: "cr_h24" | "cr_d3" | "cr_d7";
      dlKey: "dl_h24" | "dl_d3" | "dl_d7";
      mwdKey: "mwd_h24" | "mwd_d3" | "mwd_d7";
      cwdKey: "cwd_h24" | "cwd_d3" | "cwd_d7";
      obtKey: "obt_h24" | "obt_d3" | "obt_d7";
      disKey: "dis_h24" | "dis_d3" | "dis_d7";
      issKey: "iss_h24" | "iss_d3" | "iss_d7";
      clmKey: "clm_h24" | "clm_d3" | "clm_d7";
    }> = [
      { key: "h24", crKey: "cr_h24", dlKey: "dl_h24", mwdKey: "mwd_h24", cwdKey: "cwd_h24", obtKey: "obt_h24", disKey: "dis_h24", issKey: "iss_h24", clmKey: "clm_h24" },
      { key: "d3",  crKey: "cr_d3",  dlKey: "dl_d3",  mwdKey: "mwd_d3",  cwdKey: "cwd_d3",  obtKey: "obt_d3",  disKey: "dis_d3",  issKey: "iss_d3",  clmKey: "clm_d3"  },
      { key: "d7",  crKey: "cr_d7",  dlKey: "dl_d7",  mwdKey: "mwd_d7",  cwdKey: "cwd_d7",  obtKey: "obt_d7",  disKey: "dis_d7",  issKey: "iss_d7",  clmKey: "clm_d7"  },
    ];

    function buildRow(w: (typeof windows)[number]): PnlBreakdownRow {
      // Sum balance delta + manual-withdrawal across all type rows.
      let balanceDelta = 0;
      let manualWd = 0;
      let deposits = 0;
      // Map type → credit amount in this window — used for payout cats.
      const creditByType = new Map<string, number>();
      for (const r of ledger) {
        balanceDelta += toNumber(r[w.dlKey]);
        manualWd += toNumber(r[w.mwdKey]);
        const cr = toNumber(r[w.crKey]);
        creditByType.set(r.type, cr);
        if (r.type === "deposit") deposits = cr;
      }
      const cardWdAmount = toNumber(cardWd[0]?.[w.cwdKey]);
      const withdrawals = manualWd + cardWdAmount;
      const inventoryDelta =
        toNumber(inv[0]?.[w.obtKey]) -
        toNumber(inv[0]?.[w.disKey]) -
        toNumber(adminInvRem[0]?.[w.disKey]);
      const voucherDelta =
        toNumber(vch[0]?.[w.issKey]) -
        toNumber(vch[0]?.[w.clmKey]) -
        toNumber(adminVchRem[0]?.[w.clmKey]);
      // Upgrader is fully captured by balanceDelta: upgrader_bet
      // (debit) and upgrader_payout (credit) both flow through the
      // ledger now (since Upgrader shipped on packy.gg, see commit
      // 696b716 which added upgrader_payout to the canonical PAYOUT
      // type set). A prior `upgraderWon` term sourced from
      // upgrader_games.won_amount was double-subtracting every payout
      // and producing a -$150k+ phantom drag on the headline GGR / P&L
      // cards.
      const total =
        deposits -
        withdrawals -
        balanceDelta -
        inventoryDelta -
        voucherDelta;

      // Payout categories (sum credits across the types each one
      // covers). `upgraderPayouts` reads off the `upgrader_payout`
      // ledger credits like every other category.
      const payouts = {} as Record<PayoutCategoryKey, number>;
      for (const [cat, types] of Object.entries(PAYOUT_CATEGORY_TYPES) as [
        PayoutCategoryKey,
        readonly string[],
      ][]) {
        let s = 0;
        for (const t of types) s += creditByType.get(t) ?? 0;
        payouts[cat] = s;
      }

      return {
        deposits,
        withdrawals,
        balanceDelta,
        inventoryDelta,
        voucherDelta,
        total,
        ...payouts,
      };
    }

    return {
      h24: buildRow(windows[0]),
      d3: buildRow(windows[1]),
      d7: buildRow(windows[2]),
    };
  });
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

export async function getPackBattlePurePnl(): Promise<PackBattlePnlWindows> {
  return withTiming("pnl.packBattlePure", async () => {
    const db = await getDb();
    const now = Date.now();
    const h24 = new Date(now - 24 * 60 * 60 * 1000);
    const d3 = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const excluded = await getExcludedUserIds();
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
      db.$queryRawUnsafe<LedgerRow[]>(
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
      db.$queryRawUnsafe<InvRow[]>(
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
