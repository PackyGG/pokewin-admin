import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";

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

function revenueAgg(gte: Date) {
  return db.ledger_transactions.aggregate({
    where: { type: "deposit", status: "completed", created_at: { gte } },
    _sum: { amount: true },
  });
}

function ggrAgg(gte: Date) {
  return db.$queryRaw<{ ggr: string }[]>`
    SELECT (
      (
        SELECT COALESCE(SUM(CASE
          WHEN type IN ('pack_opening', 'battle_bet', 'battle_sponsorship', 'withdrawal_shipping_fee')
          THEN ABS(amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE
          WHEN type IN (
            'battle_refund', 'card_sale', 'reward_card_sale',
            'card_exchange', 'exchange_excess_credit',
            'deposit_bonus', 'race_prize', 'gift_card_redeemed',
            'promo_code_redeemed', 'rakeback_claim', 'balance_reward_claim',
            'affiliate_claim', 'rain_win', 'waitlist_prize'
          )
          THEN ABS(amount::numeric) ELSE 0 END), 0)
        FROM ledger_transactions
        WHERE status = 'completed' AND created_at >= ${gte}
      )
      - (
        SELECT COALESCE(SUM(value_at_obtained::numeric), 0)
        FROM user_inventory
        WHERE sold_at IS NULL AND exchanged_at IS NULL AND obtained_at >= ${gte}
      )
    )::text AS ggr
  `;
}

function wagerAgg(gte: Date) {
  return db.ledger_transactions.aggregate({
    where: {
      type: { in: ["pack_opening", "battle_bet", "battle_sponsorship"] },
      status: "completed",
      created_at: { gte },
    },
    _sum: { amount: true },
  });
}

export async function getDashboardStats() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

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
    dailyRevenue,
    dailySignups,
    revenue24h,
    revenue3d,
    revenue7d,
    revenue30d,
    activityTotals,
    depositCount,
    wager24h,
    wager3d,
    wager7d,
    wager30d,
    ggr24h,
    ggr3d,
    ggr7d,
    ggr30d,
    avgSessionValueResult,
    totalInventoryValue,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { created_at: { gte: startOfDay } } }),
    db.user.count({ where: { created_at: { gte: startOfWeek } } }),
    db.user.count({ where: { created_at: { gte: startOfMonth } } }),
    db.user.count({ where: { is_banned: true } }),
    db.user.count({ where: { is_locked: true } }),
    db.balances.aggregate({
      _sum: {
        total_deposited: true,
        total_withdrawn: true,
        total_wagered: true,
        total_won: true,
      },
    }),
    db.balances.aggregate({ _sum: { available_balance: true } }),
    db.card_withdrawal_requests.aggregate({
      where: { status: "pending" },
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
    db.ledger_transactions.count(),
    // Revenue last 60 days (pack openings = main revenue source)
    db.$queryRaw<{ date: Date; revenue: string }[]>`
      SELECT DATE(created_at) as date, COALESCE(SUM(amount::numeric), 0)::text as revenue
      FROM ledger_transactions
      WHERE type = 'pack_opening' AND status = 'completed'
        AND created_at >= NOW() - INTERVAL '60 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    // Signups last 60 days
    db.$queryRaw<{ date: Date; count: string }[]>`
      SELECT DATE(created_at) as date, COUNT(*)::text as count
      FROM "user"
      WHERE created_at >= NOW() - INTERVAL '60 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    revenueAgg(startOfDay),
    revenueAgg(threeDaysAgo),
    revenueAgg(sevenDaysAgo),
    revenueAgg(thirtyDaysAgo),
    db.user_statistics.aggregate({
      _sum: { opened_packs_count: true, battles_played: true },
    }),
    db.ledger_transactions.count({
      where: { type: "deposit", status: "completed" },
    }),
    wagerAgg(startOfDay),
    wagerAgg(threeDaysAgo),
    wagerAgg(sevenDaysAgo),
    wagerAgg(thirtyDaysAgo),
    ggrAgg(startOfDay),
    ggrAgg(threeDaysAgo),
    ggrAgg(sevenDaysAgo),
    ggrAgg(thirtyDaysAgo),
    db.$queryRaw<{ avg_session_value: string }[]>`
      WITH withdrawal_events AS (
        SELECT user_id, created_at, 'withdrawal' as event_type
        FROM card_withdrawal_requests
        WHERE status IN ('processing', 'shipped', 'completed')
      ),
      timeline AS (
        SELECT user_id, type::text as event_type, amount, balance_after, created_at
        FROM ledger_transactions
        WHERE status = 'completed'
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
      where: { sold_at: null, exchanged_at: null },
      _sum: { value_at_obtained: true },
    }),
  ]);

  const totalWagered = toNumber(balanceAggregates._sum.total_wagered);
  const totalWon = toNumber(balanceAggregates._sum.total_won);
  const totalActivityCount = totalAuditEvents + totalTransactions;

  return {
    users: {
      total: totalUsers,
      today: usersToday,
      week: usersWeek,
      month: usersMonth,
      banned: bannedUsers,
      locked: lockedUsers,
    },
    revenue: {
      "24h": Number(ggr24h[0]?.ggr ?? 0),
      "3d": Number(ggr3d[0]?.ggr ?? 0),
      "7d": Number(ggr7d[0]?.ggr ?? 0),
      "30d": Number(ggr30d[0]?.ggr ?? 0),
    },
    deposits: {
      "24h": toNumber(revenue24h._sum.amount),
      "3d": toNumber(revenue3d._sum.amount),
      "7d": toNumber(revenue7d._sum.amount),
      "30d": toNumber(revenue30d._sum.amount),
    },
    wagers: {
      "24h": Math.abs(toNumber(wager24h._sum.amount)),
      "3d": Math.abs(toNumber(wager3d._sum.amount)),
      "7d": Math.abs(toNumber(wager7d._sum.amount)),
      "30d": Math.abs(toNumber(wager30d._sum.amount)),
    },
    financials: {
      totalDeposited: toNumber(balanceAggregates._sum.total_deposited),
      totalWithdrawn: toNumber(balanceAggregates._sum.total_withdrawn),
      totalWagered,
      totalWon,
      totalSiteBalance: toNumber(totalSiteBalance._sum.available_balance),
      totalInventoryValue: toNumber(totalInventoryValue._sum.value_at_obtained),
      avgWagerPerDeposit: depositCount > 0 ? totalWagered / depositCount : 0,
      avgSessionValue: Number(avgSessionValueResult[0]?.avg_session_value ?? 0),
      pendingWithdrawalsCount: pendingWithdrawals._count,
      pendingWithdrawalsValue: toNumber(pendingWithdrawals._sum.total_value_usd),
    },
    packs: {
      totalOpenings: Number(packStats._sum.total_openings ?? 0),
      totalRevenue: toNumber(packStats._sum.total_revenue),
      totalPayout: toNumber(packStats._sum.total_payout),
      avgHouseEdge: toNumber(packStats._avg.actual_house_edge),
    },
    activity: {
      totalPacksOpened: Number(activityTotals._sum.opened_packs_count ?? 0),
      totalBattlesPlayed: Number(activityTotals._sum.battles_played ?? 0),
    },
    totalActivityCount,
    dailyRevenue: dailyRevenue.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      revenue: Math.abs(Number(d.revenue)),
    })),
    dailySignups: dailySignups.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      count: Number(d.count),
    })),
  };
}

export async function getRecentActivity({ page = 1, perPage = 20 }: { page?: number; perPage?: number }) {
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
