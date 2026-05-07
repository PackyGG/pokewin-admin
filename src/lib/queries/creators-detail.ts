import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import type { CreatorTipItem } from "./creators-types";

/**
 * Server-side query that powers /creators/[userId]. Returns ONLY the fields
 * the page actually renders — every property in the return shape maps to a
 * concrete consumer in `page.tsx` or one of its children.
 *
 * Previous incarnations of this function fetched payouts, webhooks, deals,
 * limits, the full referrals page (with N usages + balances), pnl by ledger
 * scan, and webhook deliveries. None of those were rendered after the page
 * was refactored to stream LeaderboardsCard + CodeActivityCard via Suspense
 * and to source deal data from the backend admin API. Removing them brings
 * this query from ~21 round-trips down to 12.
 */
export async function getCreatorDetail(
  userId: string,
  // Legacy `refPage` / `refPerPage` parameters retained for call-site
  // compatibility (page.tsx still passes 1, 1). The referrals listing was
  // dropped from the return shape because it's no longer rendered — these
  // arguments are accepted for API stability and ignored.
  _refPage?: number,
  _refPerPage?: number,
) {
  void _refPage;
  void _refPerPage;
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
        // Only the columns the page renders. The *_usd fields back the
        // FinancialsCard + the KPI strip. last_payout_at, created_at,
        // total_wager_volume_usd, total_earned_usd, total_referred are
        // intentionally dropped — none of them flow to the rendered UI
        // (the wager/earned/referred KPI tiles read from the staff-
        // excluded realAffiliateAgg below instead).
        available_usd: true,
        total_paid_out_usd: true,
        total_bonus_distributed_usd: true,
        user: {
          select: {
            username: true,
            email: true,
            image: true,
            role: true,
          },
        },
      },
    }),
    db.user.findUnique({
      where: { id: userId },
      // Only the columns the page renders. id is unused (we already have
      // userId from the route param), created_at not displayed.
      select: {
        username: true,
        email: true,
        image: true,
        role: true,
      },
    }),
  ]);

  if (!account && !userBasic) return null;

  const hasAffiliateAccount = !!account;
  const userInfo = account?.user ?? userBasic ?? null;

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // First wave — every query that only depends on userId. signupCounts +
  // ftdStats use raw SQL so each batches multiple period buckets into a
  // single round-trip. socials trims to the columns HeaderSocials renders
  // (the table also stores access tokens, JSON stat blobs, etc. that we
  // don't need on this page). realAffiliateAgg re-derives the wager
  // volume + commission with staff (admin/support) excluded — the stored
  // affiliate_accounts.total_* counters include staff and previously
  // inflated the KPI tile.
  //
  // NOTE: `user.affiliate_code` is NOT this creator's own code — it's the
  // referral cookie they are carrying from another creator who referred
  // THEM. The only source of truth for a creator's own codes is the
  // `affiliate_codes` table, populated exclusively by
  // affiliate.service.ts#createCode.
  const [
    allCodes,
    socials,
    signupCounts,
    realAffiliateAgg,
    ftdStats,
  ] = await Promise.all([
    // Only `code` is needed — primaryCode = first row, clickCodes = the
    // upper-cased set of all codes. created_at participates only in the
    // ORDER BY (no need to SELECT it).
    db.$queryRawUnsafe<{ code: string }[]>(
      `SELECT code FROM affiliate_codes WHERE user_id = $1 ORDER BY created_at ASC`,
      userId,
    ),
    // Only the fields HeaderSocials renders + last_fetched_at, which is
    // declared `lastFetchedAt: string | null` (required) on the consumer's
    // SocialLike type. Skipping access_token, refresh_token, stats_json
    // (potentially large JSON), and the various avg_views/engagement
    // columns the chip never displays.
    adminDb.creator_socials.findMany({
      where: { target_user_id: userId },
      orderBy: { platform: "asc" },
      select: {
        id: true,
        platform: true,
        username: true,
        follower_count: true,
        subscriber_count: true,
        last_fetched_at: true,
      },
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
    // Real wager + commission aggregate, excluding staff (admin +
    // support) so the KPI tiles + financials card don't double-count
    // internal accounts. The stored affiliate_accounts.total_*
    // fields are kept up-to-date by the backend but include EVERY
    // referral including staff, which is why void was inflating the
    // wager-volume tile.
    //
    // Also computes the two header KPIs that sit next to Signups:
    //   • ftd_count — distinct referred users who actually deposited
    //     (gates on both `usage_type='deposit'` for THIS creator AND
    //     a balances row with `total_deposited > 0`, matching the
    //     existing ftdByPeriod query exactly so the FunnelTable + KPI
    //     tile agree). Uses an EXISTS subquery to avoid joining
    //     balances directly — that join would multiply rows per user
    //     and inflate the SUM aggregates above.
    //   • active_7d — distinct referrals with any deposit/wager
    //     activity in the last 7 days. Drives the "Active affi"
    //     tile so the admin can see who's still engaged inside the
    //     attribution window.
    db.$queryRawUnsafe<
      {
        wager_volume: string;
        commission: string;
        ftd_count: string;
        active_7d: string;
        active_24h: string;
      }[]
    >(
      `SELECT
         COALESCE(SUM(acu.wager_amount_usd::numeric),   0)::text AS wager_volume,
         COALESCE(SUM(acu.referrer_cut_usd::numeric),   0)::text AS commission,
         COUNT(DISTINCT acu.referred_user_id) FILTER (
           WHERE acu.usage_type = 'deposit'
             AND EXISTS (
               SELECT 1 FROM balances b
               WHERE b.user_id = acu.referred_user_id
                 AND b.total_deposited > 0
             )
         )::text AS ftd_count,
         COUNT(DISTINCT acu.referred_user_id) FILTER (
           WHERE acu.usage_type IN ('deposit', 'wager')
             AND acu.created_at >= NOW() - INTERVAL '7 days'
         )::text AS active_7d,
         COUNT(DISTINCT acu.referred_user_id) FILTER (
           WHERE acu.usage_type IN ('deposit', 'wager')
             AND acu.created_at >= NOW() - INTERVAL '1 day'
         )::text AS active_24h
       FROM affiliate_code_usages acu
       JOIN "user" u ON u.id = acu.referred_user_id
       WHERE acu.affiliate_user_id = $1
         AND u.role NOT IN ('admin', 'support')`,
      userId,
    ),
    // FTD-by-period — distinct depositors referred by this creator
    // bucketed into the periods the FunnelTable renders. Independent of
    // the (now removed) referrals listing, so it lives here in the first
    // wave alongside everything else userId-only.
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
  ]);

  const signupsRow = signupCounts[0];
  const signupsTotal = Number(signupsRow?.total ?? 0);
  const signups24h = Number(signupsRow?.last_24h ?? 0);
  const signups7d = Number(signupsRow?.last_7d ?? 0);
  const signups30d = Number(signupsRow?.last_30d ?? 0);
  // Primary = oldest row in affiliate_codes (the first code this creator
  // ever minted). `allCodes` is already ORDER BY created_at ASC above.
  const primaryCode = allCodes[0]?.code ?? "";

  // Backend always inserts affiliate_clicks with code.toUpperCase() (see
  // affiliate.service.ts#trackClick), and creators can own multiple codes —
  // click totals must cover every code they own so additional codes aren't
  // silently undercounted.
  const clickCodes = Array.from(
    new Set(allCodes.map((c) => c.code.toUpperCase()).filter((c) => !!c)),
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

  const ftdByPeriod: Record<string, number> = {
    "1d": 0,
    "3d": 0,
    "7d": 0,
    "14d": 0,
    "30d": 0,
    all: 0,
  };
  for (const row of ftdStats) {
    ftdByPeriod[row.period] = Number(row.count);
  }

  return {
    userId,
    hasAffiliateAccount,
    username: userInfo?.username ?? null,
    email: userInfo?.email ?? null,
    image: userInfo?.image ?? null,
    role: userInfo?.role ?? "user",
    code: primaryCode,
    // Wager volume + commission earned override the stored
    // affiliate_accounts.total_* counters with live aggregates that
    // exclude staff (admin + support). The stored fields keep a
    // running total of every usage including staff/internal accounts,
    // which mis-states what real customer activity looks like.
    totalWagerVolumeUsd: toNumber(realAffiliateAgg[0]?.wager_volume ?? "0"),
    totalEarnedUsd: toNumber(realAffiliateAgg[0]?.commission ?? "0"),
    // FTDs (all-time, this creator's code) + active referrals in
    // multiple windows — fed into KPI tiles next to Signups. All
    // staff-excluded by the same JOIN as the wager/commission
    // aggregates. activeReferrals24h surfaces on the "Active affi"
    // tile's subtitle so the admin can see momentum at a glance.
    ftdCount: Number(realAffiliateAgg[0]?.ftd_count ?? 0),
    activeReferrals7d: Number(realAffiliateAgg[0]?.active_7d ?? 0),
    activeReferrals24h: Number(realAffiliateAgg[0]?.active_24h ?? 0),
    availableUsd: toNumber(account?.available_usd ?? 0),
    totalPaidOutUsd: toNumber(account?.total_paid_out_usd ?? 0),
    totalBonusDistributedUsd: toNumber(account?.total_bonus_distributed_usd ?? 0),
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
    socials: socials.map((s) => ({
      id: s.id,
      platform: s.platform,
      username: s.username,
      followerCount: s.follower_count,
      subscriberCount: s.subscriber_count,
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
