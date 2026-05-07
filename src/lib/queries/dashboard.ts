import { getDb } from "@/lib/db";
import type { PrismaClient } from "@/generated/prisma/client";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { MS_PER_DAY } from "@/lib/utils/time";
import { EXCLUDE_STAFF_USER_RELATION } from "./_exclude-staff";
import { getRealizedPnlSnapshot } from "./_realized-pnl";

export type ActivityItem = {
  id: string;
  source: "audit" | "transaction";
  type: string;
  username: string;
  createdAt: string;
  detail?: string;
  amount?: number;
  adminUserId?: string;
  targetUserId?: string;
  targetUsername?: string;
  userId?: string;
};

/**
 * Single raw query that returns revenue (deposits), withdrawal, wager and GGR
 * totals bucketed by period in ONE round-trip. Previously this was 20
 * separate aggregate calls (4 metrics × 5 periods) — each requires its own
 * plan + execution, and the underlying index scan is the same. Collapsing
 * into one query shaves ~15 round-trips off the hot dashboard path.
 *
 * Stores the 24h cutoff as `startOfDay` (calendar day) to match the
 * pre-existing behaviour — that's what the Dashboard UI calls "24h".
 *
 * Row shape: one text column per (metric × period). Caller converts to
 * number via toNumber / parseFloat.
 */
function getPeriodAggregates(db: PrismaClient, startOfDay: Date, threeDaysAgo: Date, sevenDaysAgo: Date, thirtyDaysAgo: Date) {
  return db.$queryRaw<
    {
      revenue_24h: string; revenue_3d: string; revenue_7d: string; revenue_30d: string; revenue_all: string;
      withdrawal_24h: string; withdrawal_3d: string; withdrawal_7d: string; withdrawal_30d: string; withdrawal_all: string;
      wager_24h: string; wager_3d: string; wager_7d: string; wager_30d: string; wager_all: string;
      ggr_24h: string; ggr_3d: string; ggr_7d: string; ggr_30d: string; ggr_all: string;
    }[]
  >`
    WITH real_users AS (
      SELECT id FROM "user" WHERE role NOT IN ('admin', 'support')
    ),
    base AS (
      SELECT type, amount::numeric AS amount, created_at
      FROM ledger_transactions
      WHERE status = 'completed'
        AND user_id IN (SELECT id FROM real_users)
    )
    SELECT
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${startOfDay}    THEN amount ELSE 0 END), 0)::text AS revenue_24h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS revenue_3d,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS revenue_7d,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS revenue_30d,
      COALESCE(SUM(CASE WHEN type = 'deposit'                                    THEN amount ELSE 0 END), 0)::text AS revenue_all,

      COALESCE(SUM(CASE WHEN type = 'card_withdrawal' AND created_at >= ${startOfDay}    THEN amount ELSE 0 END), 0)::text AS withdrawal_24h,
      COALESCE(SUM(CASE WHEN type = 'card_withdrawal' AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS withdrawal_3d,
      COALESCE(SUM(CASE WHEN type = 'card_withdrawal' AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS withdrawal_7d,
      COALESCE(SUM(CASE WHEN type = 'card_withdrawal' AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS withdrawal_30d,
      COALESCE(SUM(CASE WHEN type = 'card_withdrawal'                                    THEN amount ELSE 0 END), 0)::text AS withdrawal_all,

      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${startOfDay}    THEN amount ELSE 0 END), 0)::text AS wager_24h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_3d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_7d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS wager_30d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship')                                    THEN amount ELSE 0 END), 0)::text AS wager_all,

      -- GGR = wagers − payouts (industry-standard pure gaming margin).
      -- Same type lists as the old ggrAgg function.
      (
        COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','withdrawal_shipping_fee') AND created_at >= ${startOfDay} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN (
            'battle_refund','card_sale','reward_card_sale','card_exchange','exchange_excess_credit',
            'deposit_bonus','race_prize','gift_card_redeemed','promo_code_redeemed','rakeback_claim',
            'balance_reward_claim','affiliate_claim','rain_win','waitlist_prize','creator_tip',
            'voucher_redeemed','voucher_exchange','exchange_excess_to_voucher','battle_excess_to_voucher'
          ) AND created_at >= ${startOfDay} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_24h,
      (
        COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','withdrawal_shipping_fee') AND created_at >= ${threeDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN (
            'battle_refund','card_sale','reward_card_sale','card_exchange','exchange_excess_credit',
            'deposit_bonus','race_prize','gift_card_redeemed','promo_code_redeemed','rakeback_claim',
            'balance_reward_claim','affiliate_claim','rain_win','waitlist_prize','creator_tip',
            'voucher_redeemed','voucher_exchange','exchange_excess_to_voucher','battle_excess_to_voucher'
          ) AND created_at >= ${threeDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_3d,
      (
        COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','withdrawal_shipping_fee') AND created_at >= ${sevenDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN (
            'battle_refund','card_sale','reward_card_sale','card_exchange','exchange_excess_credit',
            'deposit_bonus','race_prize','gift_card_redeemed','promo_code_redeemed','rakeback_claim',
            'balance_reward_claim','affiliate_claim','rain_win','waitlist_prize','creator_tip',
            'voucher_redeemed','voucher_exchange','exchange_excess_to_voucher','battle_excess_to_voucher'
          ) AND created_at >= ${sevenDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_7d,
      (
        COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','withdrawal_shipping_fee') AND created_at >= ${thirtyDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN (
            'battle_refund','card_sale','reward_card_sale','card_exchange','exchange_excess_credit',
            'deposit_bonus','race_prize','gift_card_redeemed','promo_code_redeemed','rakeback_claim',
            'balance_reward_claim','affiliate_claim','rain_win','waitlist_prize','creator_tip',
            'voucher_redeemed','voucher_exchange','exchange_excess_to_voucher','battle_excess_to_voucher'
          ) AND created_at >= ${thirtyDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_30d,
      (
        COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','withdrawal_shipping_fee') THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN (
            'battle_refund','card_sale','reward_card_sale','card_exchange','exchange_excess_credit',
            'deposit_bonus','race_prize','gift_card_redeemed','promo_code_redeemed','rakeback_claim',
            'balance_reward_claim','affiliate_claim','rain_win','waitlist_prize','creator_tip',
            'voucher_redeemed','voucher_exchange','exchange_excess_to_voucher','battle_excess_to_voucher'
          ) THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_all
    FROM base
  `;
}

// Lifetime realized P&L lives in src/lib/queries/_realized-pnl.ts so the
// Analytics page can use the exact same definition. Do not inline it here.

export async function getDashboardStats() {
  return withTiming("dashboard.getDashboardStats", () => dashboardStatsInner());
}

async function dashboardStatsInner() {
  const db = await getDb();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const threeDaysAgo = new Date(now.getTime() - 3 * MS_PER_DAY);
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);

  const [
    totalUsers,
    usersToday,
    usersWeek,
    usersMonth,
    bannedUsers,
    lockedUsers,
    balanceAggregates,
    totalSiteBalance,
    pendingWithdrawals,
    packStats,
    totalAuditEvents,
    totalTransactions,
    dailyWagers,
    dailyDeposits,
    dailySignups,
    periodAggregates,
    activityTotals,
    depositCount,
    uniqueDepositorsResult,
    realizedPnlResult,
    avgSessionValueResult,
    totalInventoryValue,
    pendingConfirmationWithdrawals,
  ] = await Promise.all([
    db.user.count({ where: { role: { not: "admin" } } }),
    db.user.count({ where: { role: { not: "admin" }, created_at: { gte: startOfDay } } }),
    db.user.count({ where: { role: { not: "admin" }, created_at: { gte: startOfWeek } } }),
    db.user.count({ where: { role: { not: "admin" }, created_at: { gte: startOfMonth } } }),
    db.user.count({ where: { role: { not: "admin" }, is_banned: true } }),
    db.user.count({ where: { role: { not: "admin" }, is_locked: true } }),
    db.balances.aggregate({
      where: { user: EXCLUDE_STAFF_USER_RELATION },
      _sum: {
        total_deposited: true,
        total_withdrawn: true,
        total_wagered: true,
        total_won: true,
      },
    }),
    db.balances.aggregate({
      where: { user: EXCLUDE_STAFF_USER_RELATION },
      _sum: { available_balance: true },
    }),
    db.card_withdrawal_requests.aggregate({
      where: {
        status: { in: ["pending", "processing"] },
        user_card_withdrawal_requests_user_idTouser: EXCLUDE_STAFF_USER_RELATION,
      },
      _count: true,
      _sum: { total_value_usd: true },
    }),
    db.packs.aggregate({
      _sum: {
        total_openings: true,
        total_revenue: true,
        total_payout: true,
      },
      _avg: { actual_house_edge: true },
    }),
    adminDb.admin_audit_events.count(),
    db.ledger_transactions.count({
      where: { user: EXCLUDE_STAFF_USER_RELATION },
    }),
    // Wagers last 30 days — split by packs vs battles for stacked bar chart
    db.$queryRaw<{ date: Date; packs: string; battles: string }[]>`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(CASE WHEN type = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text as packs,
        COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') THEN ABS(amount::numeric) ELSE 0 END), 0)::text as battles
      FROM ledger_transactions
      WHERE type IN ('pack_opening','battle_bet','battle_sponsorship') AND status = 'completed'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support'))
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    // Deposits last 30 days — pure deposits (excludes deposit_bonus)
    db.$queryRaw<{ date: Date; amount: string }[]>`
      SELECT DATE(created_at) as date, COALESCE(SUM(amount::numeric), 0)::text as amount
      FROM ledger_transactions
      WHERE type = 'deposit' AND status = 'completed'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support'))
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    // Signups last 30 days
    db.$queryRaw<{ date: Date; count: string }[]>`
      SELECT DATE(created_at) as date, COUNT(*)::text as count
      FROM "user"
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND role NOT IN ('admin', 'support')
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    // Single batched query replaces 20 independent aggregates (revenue, withdrawal,
    // wager, ggr × 5 periods each). Same plan + same index scan — but one round-trip.
    getPeriodAggregates(db, startOfDay, threeDaysAgo, sevenDaysAgo, thirtyDaysAgo),
    db.user_statistics.aggregate({
      where: { user: EXCLUDE_STAFF_USER_RELATION },
      _sum: { opened_packs_count: true, battles_played: true },
    }),
    db.ledger_transactions.count({
      where: {
        type: "deposit",
        status: "completed",
        user: EXCLUDE_STAFF_USER_RELATION,
      },
    }),
    // Distinct depositor count — # of unique real users who have
    // completed at least one deposit. Powers the dashboard's
    // "Depositors" KPI. Raw SQL with COUNT(DISTINCT) avoids
    // materializing per-user rows; same staff-exclusion as everything
    // else.
    db.$queryRaw<{ count: string }[]>`
      SELECT COUNT(DISTINCT user_id)::text AS count
      FROM ledger_transactions
      WHERE type = 'deposit' AND status = 'completed'
        AND user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support'))
    `,
    getRealizedPnlSnapshot(),
    db.$queryRaw<{ avg_session_value: string }[]>`
      WITH real_users AS (
        SELECT id FROM "user" WHERE role NOT IN ('admin', 'support')
      ),
      withdrawal_events AS (
        SELECT user_id, created_at, 'withdrawal' as event_type
        FROM card_withdrawal_requests
        WHERE status IN ('processing', 'shipped', 'completed')
          AND user_id IN (SELECT id FROM real_users)
      ),
      timeline AS (
        SELECT user_id, type::text as event_type, amount, balance_after, created_at
        FROM ledger_transactions
        WHERE status = 'completed'
          AND user_id IN (SELECT id FROM real_users)
        UNION ALL
        SELECT user_id, event_type, 0 as amount, NULL as balance_after, created_at
        FROM withdrawal_events
      ),
      session_boundaries AS (
        SELECT *,
          CASE WHEN event_type = 'deposit'
               OR event_type = 'withdrawal'
               OR (balance_after IS NOT NULL AND balance_after::numeric = 0)
          THEN 1 ELSE 0 END as is_boundary
        FROM timeline
      ),
      sessions AS (
        SELECT *,
          SUM(is_boundary) OVER (PARTITION BY user_id ORDER BY created_at ROWS UNBOUNDED PRECEDING) as session_id
        FROM session_boundaries
      ),
      session_wagers AS (
        SELECT user_id, session_id,
          SUM(CASE WHEN event_type IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
              THEN ABS(amount::numeric) ELSE 0 END) as session_wager
        FROM sessions
        GROUP BY user_id, session_id
        HAVING SUM(CASE WHEN event_type IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
              THEN ABS(amount::numeric) ELSE 0 END) > 0
      )
      SELECT COALESCE(AVG(session_wager), 0)::text as avg_session_value
      FROM session_wagers
    `,
    db.user_inventory.aggregate({
      where: {
        sold_at: null,
        exchanged_at: null,
        // Exclude items that are locked for a pending card withdrawal —
        // they are effectively "on their way out" of the user's on-site
        // holdings and shouldn't inflate the aggregate balance.
        withdrawal_locked_at: null,
        user: EXCLUDE_STAFF_USER_RELATION,
      },
      _sum: { value_at_obtained: true },
    }),
    db.card_withdrawal_requests.aggregate({
      where: {
        status: "pending",
        user_card_withdrawal_requests_user_idTouser: EXCLUDE_STAFF_USER_RELATION,
      },
      _count: true,
      _sum: { total_value_usd: true },
    }),
  ]);

  const totalWagered = toNumber(balanceAggregates._sum?.total_wagered);
  const totalWon = toNumber(balanceAggregates._sum?.total_won);
  const totalActivityCount = totalAuditEvents + totalTransactions;

  // Unpack the batched period aggregates. Each field is a text-encoded
  // numeric; parseFloat() is sufficient because we're always going
  // through Number coercion anyway downstream.
  const pa = periodAggregates[0] ?? {
    revenue_24h: "0", revenue_3d: "0", revenue_7d: "0", revenue_30d: "0", revenue_all: "0",
    withdrawal_24h: "0", withdrawal_3d: "0", withdrawal_7d: "0", withdrawal_30d: "0", withdrawal_all: "0",
    wager_24h: "0", wager_3d: "0", wager_7d: "0", wager_30d: "0", wager_all: "0",
    ggr_24h: "0", ggr_3d: "0", ggr_7d: "0", ggr_30d: "0", ggr_all: "0",
  };
  const num = (s: string) => parseFloat(s) || 0;

  return {
    users: {
      total: totalUsers,
      today: usersToday,
      week: usersWeek,
      month: usersMonth,
      banned: bannedUsers,
      locked: lockedUsers,
    },
    // Gaming margin (wagers − payouts) per period. Pure GGR, no liability
    // adjustment. Use realizedPnl for the balance-sheet-true number.
    ggr: {
      "24h": num(pa.ggr_24h),
      "3d": num(pa.ggr_3d),
      "7d": num(pa.ggr_7d),
      "30d": num(pa.ggr_30d),
      all: num(pa.ggr_all),
    },
    // Lifetime realized P&L from the house perspective — see getRealizedPnlSnapshot.
    // This is a single snapshot value, not a period series.
    realizedPnl: realizedPnlResult.pnl,
    deposits: {
      "24h": num(pa.revenue_24h),
      "3d": num(pa.revenue_3d),
      "7d": num(pa.revenue_7d),
      "30d": num(pa.revenue_30d),
      all: num(pa.revenue_all),
    },
    // card_withdrawal amounts are stored as negative ledger entries, so
    // abs() to surface a positive "outflow" magnitude.
    withdrawals: {
      "24h": Math.abs(num(pa.withdrawal_24h)),
      "3d": Math.abs(num(pa.withdrawal_3d)),
      "7d": Math.abs(num(pa.withdrawal_7d)),
      "30d": Math.abs(num(pa.withdrawal_30d)),
      all: Math.abs(num(pa.withdrawal_all)),
    },
    wagers: {
      "24h": Math.abs(num(pa.wager_24h)),
      "3d": Math.abs(num(pa.wager_3d)),
      "7d": Math.abs(num(pa.wager_7d)),
      "30d": Math.abs(num(pa.wager_30d)),
      all: Math.abs(num(pa.wager_all)),
    },
    financials: {
      totalDeposited: toNumber(balanceAggregates._sum?.total_deposited),
      totalWithdrawn: toNumber(balanceAggregates._sum?.total_withdrawn),
      totalWagered,
      totalWon,
      totalSiteBalance: toNumber(totalSiteBalance._sum?.available_balance),
      totalInventoryValue: toNumber(totalInventoryValue._sum?.value_at_obtained),
      avgWagerPerDeposit: depositCount > 0 ? totalWagered / depositCount : 0,
      avgDeposit:
        depositCount > 0
          ? toNumber(balanceAggregates._sum?.total_deposited) / depositCount
          : 0,
      depositCount,
      // Unique players who have ever completed at least one deposit
      // (real users only; staff excluded via EXCLUDE_STAFF). Distinct
      // from depositCount above which counts deposit transactions —
      // a single user with five deposits = depositCount 5,
      // uniqueDepositors 1.
      uniqueDepositors: Number(uniqueDepositorsResult[0]?.count ?? 0),
      avgSessionValue: Number(avgSessionValueResult[0]?.avg_session_value ?? 0),
      pendingWithdrawalsCount: pendingWithdrawals._count,
      pendingWithdrawalsValue: toNumber(pendingWithdrawals._sum?.total_value_usd),
      // Separate from pendingWithdrawalsCount/Value above: those include
      // both `pending` and `processing` (everything in-flight). This one
      // is strictly `pending` — withdrawals waiting for admin to pick up.
      pendingConfirmationCount: pendingConfirmationWithdrawals._count,
      pendingConfirmationValue: toNumber(
        pendingConfirmationWithdrawals._sum?.total_value_usd
      ),
    },
    packs: {
      totalOpenings: Number(packStats._sum.total_openings ?? 0),
      totalRevenue: toNumber(packStats._sum.total_revenue),
      totalPayout: toNumber(packStats._sum.total_payout),
      avgHouseEdge: toNumber(packStats._avg.actual_house_edge),
    },
    activity: {
      totalPacksOpened: Number(activityTotals._sum?.opened_packs_count ?? 0),
      totalBattlesPlayed: Number(activityTotals._sum?.battles_played ?? 0),
    },
    totalActivityCount,
    dailyWagers: dailyWagers.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      packs: Number(d.packs),
      battles: Number(d.battles),
    })),
    dailyDeposits: dailyDeposits.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      amount: Math.abs(Number(d.amount)),
    })),
    dailySignups: dailySignups.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      count: Number(d.count),
    })),
  };
}

export async function getRecentActivity({ page = 1, perPage = 20 }: { page?: number; perPage?: number }) {
  const db = await getDb();
  const skip = (page - 1) * perPage;

  // Fetch from both sources with enough items to fill the page
  const [auditEvents, transactions, totalAudit, totalTx] = await Promise.all([
    adminDb.admin_audit_events.findMany({
      take: skip + perPage,
      orderBy: { created_at: "desc" },
      include: { admin_user: { select: { username: true, email: true } } },
    }),
    db.ledger_transactions.findMany({
      take: skip + perPage,
      orderBy: { created_at: "desc" },
      include: { user: { select: { username: true, email: true } } },
    }),
    adminDb.admin_audit_events.count(),
    db.ledger_transactions.count(),
  ]);

  // Resolve target user usernames from the main DB
  const targetUserIds = [
    ...new Set([
      ...auditEvents.map((e) => e.target_user_id).filter(Boolean),
      ...transactions.map((t) => t.user_id),
    ]),
  ] as string[];

  const targetUsers =
    targetUserIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: targetUserIds } },
          select: { id: true, username: true, email: true },
        })
      : [];

  const userMap = new Map(
    targetUsers.map((u) => [u.id, u.username ?? u.email ?? "Unknown"])
  );

  const auditItems: ActivityItem[] = auditEvents.map((e) => ({
    id: e.id,
    source: "audit",
    type: e.event_type,
    username: e.admin_user?.username ?? e.admin_user?.email ?? "System",
    createdAt: e.created_at.toISOString(),
    adminUserId: e.admin_user_id ?? undefined,
    targetUserId: e.target_user_id ?? undefined,
    targetUsername: e.target_user_id ? userMap.get(e.target_user_id) ?? "Unknown" : undefined,
  }));
  const txItems: ActivityItem[] = transactions.map((t) => ({
    id: t.id,
    source: "transaction",
    type: t.type,
    username: t.user?.username ?? t.user?.email ?? "Unknown",
    createdAt: t.created_at.toISOString(),
    detail: t.description,
    amount: toNumber(t.amount),
    userId: t.user_id,
    targetUsername: t.user?.username ?? t.user?.email ?? "Unknown",
  }));

  const merged = [...auditItems, ...txItems]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = totalAudit + totalTx;
  const data = merged.slice(skip, skip + perPage);

  return {
    data,
    page,
    perPage,
    total,
    totalPages: Math.ceil(total / perPage),
  };
}
