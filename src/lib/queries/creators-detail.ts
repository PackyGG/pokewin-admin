import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { getCreatorPnl } from "./creators-pnl";
import type { CreatorTipItem } from "./creators-types";

export async function getCreatorDetail(userId: string, refPage?: number, refPerPage?: number) {
  const db = await getDb();
  // Fetch the affiliate account and the user record in parallel. A user can
  // exist without ever being promoted to an affiliate (no affiliate_accounts
  // row, no affiliate_codes). The detail page should still render for these
  // users with an "no affiliate code yet" banner instead of a hard 404 — only
  // truly unknown user IDs should 404.
  const [account, userBasic] = await Promise.all([
    db.affiliate_accounts.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        total_referred: true,
        total_wager_volume_usd: true,
        total_earned_usd: true,
        available_usd: true,
        total_paid_out_usd: true,
        total_bonus_distributed_usd: true,
        last_payout_at: true,
        created_at: true,
        user: { select: { username: true, email: true, image: true, role: true, affiliate_code: true, affiliate_code_active: true } },
      },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        image: true,
        role: true,
        created_at: true,
      },
    }),
  ]);

  if (!account && !userBasic) return null;

  const hasAffiliateAccount = !!account;
  const userInfo = account?.user ?? userBasic ?? null;

  // Referrals list now sources from signups (user.referred_by = creatorId) so
  // we show every user who registered via this creator's link — including
  // those who haven't deposited/wagered yet. The previous implementation
  // pulled from affiliate_code_usages, which only records deposit/wager
  // events, so freshly-signed-up users were invisible in the list.
  //
  // signupsTotal / referralsTotal were previously duplicated as two separate
  // queries (same WHERE). Consolidated into one batch here, then reused.
  //
  // NOTE: `user.affiliate_code` is NOT this creator's own code — it's the
  // referral cookie they are carrying from another creator who referred THEM
  // (set/cleared by repository/user/affiliate.ts#setAffiliateCode). The only
  // source of truth for a creator's own codes is the `affiliate_codes` table,
  // populated exclusively by affiliate.service.ts#createCode. Using
  // user.affiliate_code here previously caused the admin to display a
  // different creator's code and silently miscount this creator's clicks.
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [
    referrals,
    signupCounts,
    payouts,
    allCodes,
    limits,
    webhooks,
    deals,
    socials,
    pnl,
    realAffiliateAgg,
  ] = await Promise.all([
    db.user.findMany({
      where: { referred_by: userId },
      select: {
        id: true,
        username: true,
        email: true,
        created_at: true,
      },
      orderBy: { created_at: "desc" },
      skip: ((refPage ?? 1) - 1) * (refPerPage ?? 20),
      take: refPerPage ?? 20,
    }),
    // Single batched query replaces 4 separate user.count() round-trips
    // (total + 24h + 7d + 30d). Same index scan, fewer plans + a single
    // network round-trip. Preserves the exact return semantics of the
    // four count() calls.
    db.$queryRaw<
      {
        total: string;
        last_24h: string;
        last_7d: string;
        last_30d: string;
      }[]
    >`
      SELECT
        COUNT(*)::text                                                                AS total,
        COUNT(*) FILTER (WHERE created_at >= ${oneDayAgo})::text                      AS last_24h,
        COUNT(*) FILTER (WHERE created_at >= ${sevenDaysAgo})::text                   AS last_7d,
        COUNT(*) FILTER (WHERE created_at >= ${thirtyDaysAgo})::text                  AS last_30d
      FROM "user"
      WHERE referred_by = ${userId}
    `,
    db.affiliate_payouts.findMany({
      where: { affiliate_user_id: userId },
      orderBy: { created_at: "desc" },
      take: 50,
    }),
    db.$queryRawUnsafe<{ id: string; code: string; created_at: Date }[]>(
      `SELECT id, code, created_at FROM affiliate_codes WHERE user_id = $1 ORDER BY created_at ASC`,
      userId
    ),
    db.creator_withdrawal_limits.findUnique({
      where: { user_id: userId },
    }),
    adminDb.creator_webhooks.findMany({
      where: { target_user_id: userId },
      orderBy: { created_at: "desc" },
    }),
    adminDb.creator_deals.findMany({
      where: { target_user_id: userId },
      orderBy: { created_at: "desc" },
    }),
    adminDb.creator_socials.findMany({
      where: { target_user_id: userId },
      orderBy: { platform: "asc" },
    }),
    getCreatorPnl(userId),
    // Real wager + commission aggregate, excluding staff (admin +
    // support) so the KPI tiles + financials card don't double-count
    // internal accounts. The stored affiliate_accounts.total_*
    // fields are kept up-to-date by the backend but include EVERY
    // referral including staff, which is why void was inflating the
    // wager-volume tile. Re-aggregating here is one extra query but
    // it's a flat scan of affiliate_code_usages joined to user, which
    // already runs sub-second per creator.
    db.$queryRawUnsafe<
      {
        wager_volume: string;
        commission: string;
        total_referred: string;
      }[]
    >(
      `SELECT
         COALESCE(SUM(acu.wager_amount_usd::numeric),   0)::text AS wager_volume,
         COALESCE(SUM(acu.referrer_cut_usd::numeric),   0)::text AS commission,
         COUNT(DISTINCT acu.referred_user_id)::text              AS total_referred
       FROM affiliate_code_usages acu
       JOIN "user" u ON u.id = acu.referred_user_id
       WHERE acu.affiliate_user_id = $1
         AND u.role NOT IN ('admin', 'support')`,
      userId,
    ),
  ]);

  const signupsRow = signupCounts[0];
  const signupsTotal = Number(signupsRow?.total ?? 0);
  const signups24h = Number(signupsRow?.last_24h ?? 0);
  const signups7d = Number(signupsRow?.last_7d ?? 0);
  const signups30d = Number(signupsRow?.last_30d ?? 0);
  const referralsTotal = signupsTotal;
  // Primary = oldest row in affiliate_codes (the first code this creator
  // ever minted). `allCodes` is already ORDER BY created_at ASC above.
  const primaryCode = allCodes[0]?.code ?? "";

  // Backend always inserts affiliate_clicks with code.toUpperCase() (see
  // affiliate.service.ts#trackClick), and creators can own multiple codes —
  // click totals must cover every code they own so additional codes aren't
  // silently undercounted.
  const clickCodes = Array.from(
    new Set(
      allCodes.map((c) => c.code.toUpperCase()).filter((c) => !!c),
    ),
  );

  const now_clicks_24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const now_clicks_7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const now_clicks_30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Hourly (24 buckets) and daily (7 buckets) time-series for the
  // acquisition chart. Uses generate_series + LEFT JOIN so empty buckets
  // still appear as 0 instead of being skipped — required for a continuous
  // bar chart. Runs a noop when the creator owns no codes.
  const hasClickCodes = clickCodes.length > 0;

  const [
    clickCounts,
    pendingSignups,
    acquisitionHourly,
    acquisitionDaily,
    countryBreakdown,
  ] = await Promise.all([
    // Single batched aggregate replaces 4 separate affiliate_clicks.count()
    // round-trips (total + 24h + 7d + 30d). One index scan with FILTER
    // clauses, no extra plans.
    hasClickCodes
      ? db.$queryRaw<
          {
            total: string;
            last_24h: string;
            last_7d: string;
            last_30d: string;
          }[]
        >`
          SELECT
            COUNT(*)::text                                                              AS total,
            COUNT(*) FILTER (WHERE created_at >= ${now_clicks_24h})::text               AS last_24h,
            COUNT(*) FILTER (WHERE created_at >= ${now_clicks_7d})::text                AS last_7d,
            COUNT(*) FILTER (WHERE created_at >= ${now_clicks_30d})::text               AS last_30d
          FROM affiliate_clicks
          WHERE code = ANY(${clickCodes}::text[])
        `
      : Promise.resolve(
          [] as { total: string; last_24h: string; last_7d: string; last_30d: string }[],
        ),
    primaryCode
      ? db.affiliate_code_queue.count({ where: { code: primaryCode } })
      : Promise.resolve(0),
    db.$queryRawUnsafe<{ bucket: string; clicks: number; signups: number }[]>(
      `
      WITH series AS (
        SELECT generate_series(
          date_trunc('hour', NOW() - INTERVAL '23 hours'),
          date_trunc('hour', NOW()),
          INTERVAL '1 hour'
        ) AS bucket
      ),
      clicks_agg AS (
        SELECT date_trunc('hour', created_at) AS bucket, COUNT(*)::int AS n
        FROM affiliate_clicks
        WHERE code = ANY($1::text[])
          AND created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY 1
      ),
      signups_agg AS (
        SELECT date_trunc('hour', created_at) AS bucket, COUNT(*)::int AS n
        FROM "user"
        WHERE referred_by = $2
          AND created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY 1
      )
      SELECT s.bucket::text AS bucket,
             COALESCE(c.n, 0) AS clicks,
             COALESCE(su.n, 0) AS signups
      FROM series s
      LEFT JOIN clicks_agg c ON c.bucket = s.bucket
      LEFT JOIN signups_agg su ON su.bucket = s.bucket
      ORDER BY s.bucket ASC
      `,
      hasClickCodes ? clickCodes : ["__none__"],
      userId,
    ),
    db.$queryRawUnsafe<{ bucket: string; clicks: number; signups: number }[]>(
      `
      WITH series AS (
        SELECT generate_series(
          date_trunc('day', NOW() - INTERVAL '6 days'),
          date_trunc('day', NOW()),
          INTERVAL '1 day'
        ) AS bucket
      ),
      clicks_agg AS (
        SELECT date_trunc('day', created_at) AS bucket, COUNT(*)::int AS n
        FROM affiliate_clicks
        WHERE code = ANY($1::text[])
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY 1
      ),
      signups_agg AS (
        SELECT date_trunc('day', created_at) AS bucket, COUNT(*)::int AS n
        FROM "user"
        WHERE referred_by = $2
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY 1
      )
      SELECT s.bucket::text AS bucket,
             COALESCE(c.n, 0) AS clicks,
             COALESCE(su.n, 0) AS signups
      FROM series s
      LEFT JOIN clicks_agg c ON c.bucket = s.bucket
      LEFT JOIN signups_agg su ON su.bucket = s.bucket
      ORDER BY s.bucket ASC
      `,
      hasClickCodes ? clickCodes : ["__none__"],
      userId,
    ),
    // Country-level breakdown. Clicks are stored with the FULL country
    // name (affiliate_clicks.country, populated by the geolocation service
    // at track time). Signed-up users also carry a `country` column from
    // the same service at signup. Joining on the full name is therefore
    // safe — they flow from the same source. FULL OUTER JOIN so countries
    // with only clicks OR only signups both show up.
    db.$queryRawUnsafe<{ country: string; clicks: number; signups: number }[]>(
      `
      WITH click_countries AS (
        SELECT country, COUNT(*)::int AS clicks
        FROM affiliate_clicks
        WHERE code = ANY($1::text[])
          AND country IS NOT NULL AND country <> 'unknown'
        GROUP BY country
      ),
      signup_countries AS (
        SELECT country, COUNT(*)::int AS signups
        FROM "user"
        WHERE referred_by = $2
          AND country IS NOT NULL AND country <> ''
        GROUP BY country
      )
      SELECT
        COALESCE(c.country, s.country) AS country,
        COALESCE(c.clicks, 0) AS clicks,
        COALESCE(s.signups, 0) AS signups
      FROM click_countries c
      FULL OUTER JOIN signup_countries s ON c.country = s.country
      WHERE COALESCE(c.country, s.country) IS NOT NULL
      ORDER BY (COALESCE(c.clicks, 0) + COALESCE(s.signups, 0)) DESC
      LIMIT 30
      `,
      hasClickCodes ? clickCodes : ["__none__"],
      userId,
    ),
  ]);

  // Unpack the consolidated click counts (4 buckets in 1 row).
  const clicksRow = clickCounts[0];
  const clickCount = Number(clicksRow?.total ?? 0);
  const clicks24h = Number(clicksRow?.last_24h ?? 0);
  const clicks7d = Number(clicksRow?.last_7d ?? 0);
  const clicks30d = Number(clicksRow?.last_30d ?? 0);

  // For each signed-up user, look up their aggregated usage data +
  // balance. If the user hasn't deposited/wagered yet we still show
  // them in the list with zeros, so the admin can see who signed up.
  //
  // All three data sources (usages, balances, ftdStats, webhook deliveries)
  // are independent — parallelized so the detail page isn't serial-bound
  // on four round-trips. Previously ftdStats and the webhook deliveries
  // N+1 were both sequential after this block; now they all run together.
  const referredUserIds = referrals.map((r) => r.id);
  const webhookIds = webhooks.map((w) => w.id);
  const usageMap = new Map<
    string,
    {
      depositAmountUsd: number;
      wagerAmountUsd: number;
      referrerCutUsd: number;
      userBonusUsd: number;
      usageCount: number;
      lastUsageType: string | null;
    }
  >();
  let ftdMap = new Map<string, boolean>();
  const [usages, balances, ftdStats, webhookDeliveries] = await Promise.all([
    referredUserIds.length > 0
      ? db.affiliate_code_usages.findMany({
          where: {
            affiliate_user_id: userId,
            referred_user_id: { in: referredUserIds },
          },
          orderBy: { created_at: "desc" },
        })
      : Promise.resolve(
          [] as Awaited<ReturnType<typeof db.affiliate_code_usages.findMany>>,
        ),
    referredUserIds.length > 0
      ? db.balances.findMany({
          where: { user_id: { in: referredUserIds } },
          select: { user_id: true, total_deposited: true },
        })
      : Promise.resolve(
          [] as Awaited<
            ReturnType<
              typeof db.balances.findMany<{
                select: { user_id: true; total_deposited: true };
              }>
            >
          >,
        ),
    db.$queryRawUnsafe<{ period: string; count: string }[]>(
      `
      SELECT period, COUNT(*)::text AS count FROM (
        SELECT DISTINCT acu.referred_user_id, p.period
        FROM affiliate_code_usages acu
        JOIN balances b ON b.user_id = acu.referred_user_id AND b.total_deposited > 0
        CROSS JOIN (VALUES ('1d'), ('3d'), ('7d'), ('14d'), ('30d'), ('all')) AS p(period)
        WHERE acu.affiliate_user_id = $1
          AND acu.usage_type = 'deposit'
          AND (
            p.period = 'all'
            OR acu.created_at >= NOW() - CASE p.period
              WHEN '1d' THEN INTERVAL '1 day'
              WHEN '3d' THEN INTERVAL '3 days'
              WHEN '7d' THEN INTERVAL '7 days'
              WHEN '14d' THEN INTERVAL '14 days'
              WHEN '30d' THEN INTERVAL '30 days'
            END
          )
      ) sub
      GROUP BY period
    `,
      userId,
    ),
    // Webhook deliveries — one batched query with a LATERAL join to keep
    // "5 most recent per webhook". Previously this was N separate queries
    // (one per webhook). The `deliveries` table has webhook_id indexed so
    // the lateral join is cheap even at a few dozen webhooks.
    webhookIds.length > 0
      ? adminDb.$queryRawUnsafe<
          {
            id: string;
            webhook_id: string;
            event_type: string;
            status_code: number | null;
            success: boolean;
            attempt: number;
            created_at: Date;
          }[]
        >(
          `
          SELECT d.id::text AS id, d.webhook_id::text AS webhook_id,
                 d.event_type, d.status_code, d.success, d.attempt, d.created_at
          FROM unnest($1::uuid[]) AS w(webhook_id)
          CROSS JOIN LATERAL (
            SELECT id, webhook_id, event_type, status_code, success, attempt, created_at
            FROM webhook_deliveries
            WHERE webhook_id = w.webhook_id
            ORDER BY created_at DESC
            LIMIT 5
          ) d
        `,
          webhookIds,
        )
      : Promise.resolve([] as never[]),
  ]);
  for (const u of usages) {
    const prev = usageMap.get(u.referred_user_id) ?? {
      depositAmountUsd: 0,
      wagerAmountUsd: 0,
      referrerCutUsd: 0,
      userBonusUsd: 0,
      usageCount: 0,
      lastUsageType: null,
    };
    usageMap.set(u.referred_user_id, {
      depositAmountUsd: prev.depositAmountUsd + toNumber(u.deposit_amount_usd),
      wagerAmountUsd: prev.wagerAmountUsd + toNumber(u.wager_amount_usd),
      referrerCutUsd: prev.referrerCutUsd + toNumber(u.referrer_cut_usd),
      userBonusUsd: prev.userBonusUsd + toNumber(u.user_bonus_usd),
      usageCount: prev.usageCount + 1,
      lastUsageType: prev.lastUsageType ?? u.usage_type,
    });
  }
  ftdMap = new Map(
    balances.map((b) => [b.user_id, toNumber(b.total_deposited) > 0]),
  );

  const ftdByPeriod: Record<string, number> = { "1d": 0, "3d": 0, "7d": 0, "14d": 0, "30d": 0, all: 0 };
  for (const row of ftdStats) {
    ftdByPeriod[row.period] = Number(row.count);
  }

  // Build webhook -> deliveries map once, then join in the return shape.
  const deliveriesByWebhookId = new Map<
    string,
    Array<{
      id: string;
      eventType: string;
      statusCode: number | null;
      success: boolean;
      attempt: number;
      createdAt: string;
    }>
  >();
  for (const d of webhookDeliveries) {
    const list = deliveriesByWebhookId.get(d.webhook_id) ?? [];
    list.push({
      id: d.id,
      eventType: d.event_type,
      statusCode: d.status_code,
      success: d.success,
      attempt: d.attempt,
      createdAt: d.created_at.toISOString(),
    });
    deliveriesByWebhookId.set(d.webhook_id, list);
  }
  const webhooksWithDeliveries = webhooks.map((w) => ({
    id: w.id,
    url: w.url,
    type: w.type,
    enabled: w.enabled,
    createdAt: w.created_at.toISOString(),
    deliveries: deliveriesByWebhookId.get(w.id) ?? [],
  }));

  return {
    userId,
    hasAffiliateAccount,
    username: userInfo?.username ?? null,
    email: userInfo?.email ?? null,
    image: userInfo?.image ?? null,
    role: userInfo?.role ?? "user",
    code: primaryCode,
    // Presence in affiliate_codes is the only authoritative "has a code"
    // signal. user.affiliate_code_active tracks the referral cookie on this
    // user (unrelated to whether they OWN any creator codes).
    codeActive: allCodes.length > 0,
    level: 1,
    // Wager volume + commission earned override the stored
    // affiliate_accounts.total_* counters with live aggregates that
    // exclude staff (admin + support). The stored fields keep a
    // running total of every usage including staff/internal accounts,
    // which mis-states what real customer activity looks like.
    // Stored total_referred is kept as the floor (it's a count of
    // distinct referred users which the backend maintains
    // deduplicated) but we override with the staff-excluded count
    // when it returns a smaller number — prefer the lower one to
    // avoid showing a count that's larger than the activity behind it.
    totalReferred: Math.min(
      account?.total_referred ?? 0,
      Number(realAffiliateAgg[0]?.total_referred ?? 0) ||
        (account?.total_referred ?? 0),
    ),
    totalWagerVolumeUsd: toNumber(realAffiliateAgg[0]?.wager_volume ?? "0"),
    totalEarnedUsd: toNumber(realAffiliateAgg[0]?.commission ?? "0"),
    availableUsd: toNumber(account?.available_usd ?? 0),
    totalPaidOutUsd: toNumber(account?.total_paid_out_usd ?? 0),
    totalBonusDistributedUsd: toNumber(account?.total_bonus_distributed_usd ?? 0),
    lastPayoutAt: account?.last_payout_at?.toISOString() ?? null,
    totalClicks: clickCount,
    clicks: {
      total: clickCount,
      last24h: clicks24h,
      last7d: clicks7d,
      last30d: clicks30d,
    },
    acquisition: {
      hourly: acquisitionHourly.map((r) => ({
        bucket: r.bucket,
        clicks: Number(r.clicks),
        signups: Number(r.signups),
      })),
      daily: acquisitionDaily.map((r) => ({
        bucket: r.bucket,
        clicks: Number(r.clicks),
        signups: Number(r.signups),
      })),
    },
    countryBreakdown: countryBreakdown.map((r) => ({
      country: r.country,
      clicks: Number(r.clicks),
      signups: Number(r.signups),
    })),
    signups: {
      total: signupsTotal,
      last24h: signups24h,
      last7d: signups7d,
      last30d: signups30d,
      pending: pendingSignups,
    },
    ftdByPeriod,
    pnl,
    createdAt: (account?.created_at ?? userBasic?.created_at ?? new Date()).toISOString(),
    additionalCodes: allCodes.map((c) => ({
      id: c.id,
      code: c.code,
      isActive: true,
      createdAt: c.created_at.toISOString(),
    })),
    limits: limits
      ? {
          id: limits.id,
          currencyLimitAmount: toNumber(limits.currency_limit_amount),
          percentageLimit: toNumber(limits.percentage_limit),
          tipLimit: null,
          currencyLimitResetDays: limits.currency_limit_reset_days,
        }
      : null,
    referrals: {
      data: referrals.map((r) => {
        const usage = usageMap.get(r.id);
        return {
          id: r.id,
          referredUserId: r.id,
          referredUsername: r.username ?? null,
          usageType: usage?.lastUsageType ?? "signup",
          depositAmountUsd: usage?.depositAmountUsd ?? 0,
          wagerAmountUsd: usage?.wagerAmountUsd ?? 0,
          referrerCutUsd: usage?.referrerCutUsd ?? 0,
          userBonusUsd: usage?.userBonusUsd ?? 0,
          isFtd: ftdMap.get(r.id) ?? false,
          createdAt: r.created_at.toISOString(),
        };
      }),
      total: referralsTotal,
      page: refPage ?? 1,
      perPage: refPerPage ?? 20,
      totalPages: Math.ceil(referralsTotal / (refPerPage ?? 20)),
    },
    payouts: payouts.map((p) => ({
      id: p.id,
      amountUsd: toNumber(p.amount_usd),
      status: p.status,
      createdAt: p.created_at.toISOString(),
    })),
    webhooks: webhooksWithDeliveries,
    deals: deals.map((d) => ({
      id: d.id,
      dealName: d.deal_name,
      dealType: d.deal_type,
      amount: toNumber(d.amount),
      currency: d.currency,
      startDate: d.start_date.toISOString(),
      endDate: d.end_date?.toISOString() ?? null,
      status: d.status,
      notes: d.notes,
      dailyFillAmount: toNumber(d.daily_fill_amount),
      dailyFillTime: d.daily_fill_time,
      dailyFillEnabled: d.daily_fill_enabled,
      keepPercentage: toNumber(d.keep_percentage),
      currencyLimitAmount: toNumber(d.currency_limit_amount),
      currencyLimitResetDays: d.currency_limit_reset_days,
      percentageLimit: toNumber(d.percentage_limit),
      tipLimit: toNumber(d.tip_limit),
      tipLimitResetDays: d.tip_limit_reset_days,
      leaderboardPrizePool: toNumber(d.leaderboard_prize_pool),
      leaderboardOurShare: toNumber(d.leaderboard_our_share),
      leaderboardFrequency: d.leaderboard_frequency,
      minStreamMinutes: d.min_stream_minutes,
      maxFinancialExposure: toNumber(d.max_financial_exposure),
      createdAt: d.created_at.toISOString(),
    })),
    socials: socials.map((s) => ({
      id: s.id,
      platform: s.platform,
      username: s.username,
      followerCount: s.follower_count,
      subscriberCount: s.subscriber_count,
      totalViews: s.total_views ? Number(s.total_views) : null,
      avgViews30d: s.avg_views_30d,
      avgViewers: s.avg_viewers,
      avgViewers30d: s.avg_viewers_30d,
      engagementRate: s.engagement_rate ? toNumber(s.engagement_rate) : null,
      likesAvg: s.likes_avg,
      lastFetchedAt: s.last_fetched_at?.toISOString() ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Creator Tips — rain tips sent by this creator
// ---------------------------------------------------------------------------

export async function getCreatorTips(
  userId: string,
  page: number = 1,
  perPage: number = 20,
): Promise<PaginatedResult<CreatorTipItem> & { totalTipped: number }> {
  const db = await getDb();
  const [tips, total, totalAgg] = await Promise.all([
    db.rain_tips.findMany({
      where: { user_id: userId },
      include: {
        rains: {
          select: {
            id: true,
            total_pool_usd: true,
            status: true,
            winner_user_id: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.rain_tips.count({ where: { user_id: userId } }),
    db.rain_tips.aggregate({
      where: { user_id: userId },
      _sum: { amount_usd: true },
    }),
  ]);

  // Batch-fetch winner usernames
  const winnerIds = [
    ...new Set(
      tips
        .map((t) => t.rains.winner_user_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const winners =
    winnerIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: winnerIds } },
          select: { id: true, username: true, email: true },
        })
      : [];
  const winnerMap = new Map(
    winners.map((w) => [w.id, w.username ?? w.email ?? w.id.slice(0, 8)]),
  );

  return {
    data: tips.map((t) => ({
      id: t.id,
      rainId: t.rain_id,
      amountUsd: toNumber(t.amount_usd),
      rainTotalPool: toNumber(t.rains.total_pool_usd),
      rainStatus: t.rains.status,
      rainWinnerUsername: t.rains.winner_user_id
        ? winnerMap.get(t.rains.winner_user_id) ?? null
        : null,
      createdAt: t.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
    totalTipped: toNumber(totalAgg._sum.amount_usd ?? 0),
  };
}
