import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";

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
 * `withdrawals`    = balances.total_withdrawn (ledger withdrawals) +
 *                    sum(card_withdrawal_requests.total_value_usd) for
 *                    completed/shipped requests.
 * `inventoryValue` = sum(user_inventory.value_at_obtained) where the row is
 *                    neither sold nor exchanged.
 * `unclaimedVouchers` = sum(vouchers.value) where claimed_at IS NULL.
 *
 * House-wide (global) variants may extend this with additional liability
 * components (e.g. unclaimed rakeback). Per-user P&L sticks to the canonical
 * five terms so it lines up with the User Detail panel on the page.
 */

export type PnlComponents = {
  /** Sum of completed deposits credited to the user's balance. */
  deposits: number;
  /** balances.total_withdrawn + completed/shipped card_withdrawal_requests. */
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
    const [balances, cardWithdrawals, inventoryAgg, vouchersAgg] =
      await Promise.all([
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
            status: { in: ["completed", "shipped"] },
          },
          _sum: { total_value_usd: true },
        }),
        db.user_inventory.aggregate({
          where: {
            user_id: userId,
            sold_at: null,
            exchanged_at: null,
          },
          _sum: { value_at_obtained: true },
        }),
        db.vouchers.aggregate({
          where: { user_id: userId, claimed_at: null },
          _sum: { value: true },
        }),
      ]);

    const components: PnlComponents = {
      deposits: toNumber(balances?.total_deposited),
      withdrawals:
        toNumber(balances?.total_withdrawn) +
        toNumber(cardWithdrawals._sum.total_value_usd),
      onSiteBalance:
        toNumber(balances?.available_balance) +
        toNumber(balances?.locked_balance),
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
 */
export async function calculateWindowedPnl(opts: {
  since: Date;
  userId?: string;
  excludeUserIds?: string[];
}): Promise<WindowedPnl> {
  const { since, userId, excludeUserIds = [] } = opts;
  return withTiming("pnl.windowed", async () => {
    const db = await getDb();

    // Per-table user scope. Single-user binds the id as positional $2;
    // global filters to non-staff users minus the blacklist (ids come
    // from a trusted admin source, escaped defensively).
    const blacklist =
      excludeUserIds.length > 0
        ? `AND u.id NOT IN (${excludeUserIds
            .map((id) => `'${id.replace(/'/g, "''")}'`)
            .join(",")})`
        : "";
    const scope = (col: string) =>
      userId
        ? `${col} = $2`
        : `${col} IN (SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support') ${blacklist})`;
    const params: unknown[] = userId ? [since, userId] : [since];

    type LedgerRow = { deposits: string; manual_wd: string; balance_change: string };
    type CardRow = { card_wd: string };
    type InvRow = { obtained: string; disposed: string };
    type VchRow = { issued: string; claimed: string };

    const [ledger, card, inv, vch] = await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN lt.type = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::text AS deposits,
           COALESCE(SUM(CASE WHEN lt.type = 'admin_balance_adjustment'
                              AND lt.balance_after < lt.balance_before
                              AND lt.description ILIKE 'Manual withdrawal:%'
                             THEN lt.amount::numeric ELSE 0 END), 0)::text AS manual_wd,
           COALESCE(SUM((lt.balance_after - lt.balance_before)::numeric), 0)::text AS balance_change
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND lt.created_at >= $1 AND ${scope("lt.user_id")}`,
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
           COALESCE(SUM(CASE WHEN (ui.sold_at >= $1 OR ui.exchanged_at >= $1) THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS disposed
         FROM user_inventory ui
         WHERE (ui.obtained_at >= $1 OR ui.sold_at >= $1 OR ui.exchanged_at >= $1)
           AND ${scope("ui.user_id")}`,
        ...params,
      ),
      db.$queryRawUnsafe<VchRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN v.created_at >= $1 THEN v.value::numeric ELSE 0 END), 0)::text AS issued,
           COALESCE(SUM(CASE WHEN v.claimed_at >= $1 THEN v.value::numeric ELSE 0 END), 0)::text AS claimed
         FROM vouchers v
         WHERE (v.created_at >= $1 OR v.claimed_at >= $1)
           AND ${scope("v.user_id")}`,
        ...params,
      ),
    ]);

    const deposits = toNumber(ledger[0]?.deposits);
    const withdrawals =
      toNumber(ledger[0]?.manual_wd) + toNumber(card[0]?.card_wd);
    const balanceChange = toNumber(ledger[0]?.balance_change);
    const inventoryChange =
      toNumber(inv[0]?.obtained) - toNumber(inv[0]?.disposed);
    const voucherChange = toNumber(vch[0]?.issued) - toNumber(vch[0]?.claimed);
    const pnl =
      deposits - withdrawals - balanceChange - inventoryChange - voucherChange;

    return { deposits, withdrawals, balanceChange, inventoryChange, voucherChange, pnl };
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
    const [balanceRows, cardWithdrawalRows, inventoryRows, voucherRows] =
      await Promise.all([
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
            status: { in: ["completed", "shipped"] },
          },
          _sum: { total_value_usd: true },
        }),
        db.user_inventory.groupBy({
          by: ["user_id"],
          where: {
            user_id: { in: userIds },
            sold_at: null,
            exchanged_at: null,
          },
          _sum: { value_at_obtained: true },
        }),
        db.vouchers.groupBy({
          by: ["user_id"],
          where: { user_id: { in: userIds }, claimed_at: null },
          _sum: { value: true },
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

    for (const userId of userIds) {
      const b = balanceMap.get(userId);
      const components: PnlComponents = {
        deposits: toNumber(b?.total_deposited),
        withdrawals:
          toNumber(b?.total_withdrawn) + (cardWithdrawalMap.get(userId) ?? 0),
        onSiteBalance:
          toNumber(b?.available_balance) + toNumber(b?.locked_balance),
        inventoryValue: inventoryMap.get(userId) ?? 0,
        unclaimedVouchers: voucherMap.get(userId) ?? 0,
      };
      result.set(userId, { ...components, pnl: computeHousePnl(components) });
    }

    return result;
  });
}
