import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { blacklistNotInClause } from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

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
            // Cards locked for a card_withdrawal have effectively left
            // the user's holdings (awaiting shipment). Exclude them
            // from per-user PnL inventory so the User Detail / Users
            // List PnL matches the dashboard's totalInventoryValue
            // aggregate (which already filters the same way).
            withdrawal_locked_at: null,
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
    const blacklist = blacklistNotInClause("u.id", excludeUserIds);
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

export type DailyPnlPoint = {
  /** YYYY-MM-DD */
  date: string;
  /** House P&L for that day (windowed-delta formula, bucketed per day). */
  pnl: number;
  /** Gross deposits that day (context for the chart hover). */
  deposits: number;
  /** Gross withdrawals that day — |manual| + card (context for hover). */
  withdrawals: number;
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
export async function getDailyPnl(): Promise<DailyPnlPoint[]> {
  return withTiming("pnl.daily", async () => {
    const db = await getDb();
    const excluded = await getExcludedUserIds();
    const blacklist = blacklistNotInClause("u.id", excluded);
    const usersScope = `(SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support') ${blacklist})`;

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
           COALESCE(SUM(CASE WHEN lt.type = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS deposits,
           COALESCE(SUM(CASE WHEN lt.type = 'admin_balance_adjustment'
                              AND lt.balance_after < lt.balance_before
                              AND lt.description ILIKE 'Manual withdrawal:%'
                             THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS manual_wd,
           COALESCE(SUM((lt.balance_after - lt.balance_before)::numeric), 0)::float8 AS balance_change
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND lt.created_at >= NOW() - INTERVAL '30 days'
           AND lt.user_id IN ${usersScope}
         GROUP BY DATE(lt.created_at)`,
      ),
      db.$queryRawUnsafe<CardRow[]>(
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
      }))
      .sort((x, y) => x.date.localeCompare(y.date));
  });
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
    const [ledger, cardWd, inv, vch] = await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
        `SELECT type,
           COALESCE(SUM(CASE WHEN created_at >= $1 THEN GREATEST(balance_after - balance_before, 0)::numeric ELSE 0 END), 0)::text AS cr_h24,
           COALESCE(SUM(CASE WHEN created_at >= $2 THEN GREATEST(balance_after - balance_before, 0)::numeric ELSE 0 END), 0)::text AS cr_d3,
           COALESCE(SUM(CASE WHEN created_at >= $3 THEN GREATEST(balance_after - balance_before, 0)::numeric ELSE 0 END), 0)::text AS cr_d7,
           COALESCE(SUM(CASE WHEN created_at >= $1 THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS dl_h24,
           COALESCE(SUM(CASE WHEN created_at >= $2 THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS dl_d3,
           COALESCE(SUM(CASE WHEN created_at >= $3 THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS dl_d7,
           COALESCE(SUM(CASE WHEN created_at >= $1 AND type = 'admin_balance_adjustment' AND balance_after < balance_before AND description ILIKE 'Manual withdrawal:%' THEN amount::numeric ELSE 0 END), 0)::text AS mwd_h24,
           COALESCE(SUM(CASE WHEN created_at >= $2 AND type = 'admin_balance_adjustment' AND balance_after < balance_before AND description ILIKE 'Manual withdrawal:%' THEN amount::numeric ELSE 0 END), 0)::text AS mwd_d3,
           COALESCE(SUM(CASE WHEN created_at >= $3 AND type = 'admin_balance_adjustment' AND balance_after < balance_before AND description ILIKE 'Manual withdrawal:%' THEN amount::numeric ELSE 0 END), 0)::text AS mwd_d7
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
      { key: "d3",  crKey: "cr_d3",  dlKey: "dl_d3",  mwdKey: "mwd_d3",  cwdKey: "cwd_d3",  obtKey: "obt_d3",  disKey: "dis_d3",  issKey: "iss_d3",  clmKey: "clm_d3" },
      { key: "d7",  crKey: "cr_d7",  dlKey: "dl_d7",  mwdKey: "mwd_d7",  cwdKey: "cwd_d7",  obtKey: "obt_d7",  disKey: "dis_d7",  issKey: "iss_d7",  clmKey: "clm_d7" },
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
        toNumber(inv[0]?.[w.obtKey]) - toNumber(inv[0]?.[w.disKey]);
      const voucherDelta =
        toNumber(vch[0]?.[w.issKey]) - toNumber(vch[0]?.[w.clmKey]);
      const total =
        deposits - withdrawals - balanceDelta - inventoryDelta - voucherDelta;

      // Payout categories (sum credits across the types each one covers).
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
