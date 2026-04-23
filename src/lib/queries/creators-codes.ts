import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import type { CodeListItem } from "./creators-types";

export async function getCodes(params: {
  page?: number;
  perPage?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: string;
}): Promise<PaginatedResult<CodeListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;

  const db = await getDb();
  const validFields = ["code", "created_at"];
  const sortField = validFields.includes(sortBy) ? sortBy : "created_at";
  const direction = sortOrder === "asc" ? "ASC" : "DESC";

  let whereClause = "WHERE 1=1";
  const queryParams: string[] = [];
  if (search) {
    queryParams.push(`%${search}%`);
    whereClause = `WHERE (ac.code ILIKE $1 OR u.username ILIKE $1)`;
  }

  const offset = (page - 1) * perPage;

  const [codes, countRows] = await Promise.all([
    db.$queryRawUnsafe<
      { code: string; user_id: string; created_at: Date; username: string | null }[]
    >(
      `SELECT ac.code, ac.user_id, ac.created_at, u.username
       FROM affiliate_codes ac
       JOIN "user" u ON u.id = ac.user_id
       ${whereClause}
       ORDER BY ac.${sortField} ${direction}
       LIMIT ${perPage} OFFSET ${offset}`,
      ...queryParams
    ),
    db.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM affiliate_codes ac
       JOIN "user" u ON u.id = ac.user_id
       ${whereClause}`,
      ...queryParams
    ),
  ]);

  const total = Number(countRows[0]?.count ?? 0);

  return {
    data: codes.map((c) => ({
      code: c.code,
      ownerUserId: c.user_id,
      ownerUsername: c.username ?? null,
      isActive: true,
      createdAt: c.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getCodeAnalytics(code: string) {
  // Code casing history:
  //  - affiliate_clicks: always UPPERCASE (trackClick does code.toUpperCase()
  //    before insert — backend/src/routes/v1/affiliate/track.ts).
  //  - affiliate_codes: MIXED. createCode uppercases new codes, but migration
  //    0068 backfilled pre-existing codes from affiliate_accounts.code
  //    as-is, so legacy rows can be lowercase/mixed-case (e.g. "insta1").
  //  - affiliate_code_usages: mirrors whatever casing the caller resolved
  //    from affiliate_codes, so also MIXED for legacy codes.
  //
  // We therefore: (1) look up the code record case-insensitively to handle
  // legacy rows, (2) use the ROW's stored casing for usages queries so they
  // match the actual insert casing, (3) use UPPERCASE for affiliate_clicks
  // where we know the stored casing is always upper.
  const db = await getDb();
  const uppercaseCode = code.toUpperCase();

  const codeRecord = await db
    .$queryRawUnsafe<{ code: string; user_id: string; username: string | null }[]>(
      `SELECT ac.code, ac.user_id, u.username
       FROM affiliate_codes ac
       JOIN "user" u ON u.id = ac.user_id
       WHERE UPPER(ac.code) = $1
       LIMIT 1`,
      uppercaseCode
    )
    .then((rows) => (rows[0] ? { ...rows[0], is_active: true } : null));

  if (!codeRecord) return null;

  const [
    usages,
    totalReferralsCount,
    clickCount,
    dailyUsages,
    dailyClicks,
    countryBreakdown,
    acquisitionHourly,
    acquisitionDaily,
  ] = await Promise.all([
    db.affiliate_code_usages.findMany({
      where: { code: { equals: uppercaseCode, mode: "insensitive" } },
      include: {
        user_affiliate_code_usages_referred_user_idTouser: {
          select: { username: true },
        },
      },
      orderBy: { created_at: "desc" },
      take: 50,
    }),
    db.affiliate_code_usages.count({
      where: { code: { equals: uppercaseCode, mode: "insensitive" } },
    }),
    db.affiliate_clicks.count({ where: { code: uppercaseCode } }),
    db.$queryRawUnsafe<
      {
        date: Date;
        referrals: string;
        deposit_volume: string;
        wager_volume: string;
        commission: string;
      }[]
    >(`
      SELECT
        DATE(created_at) AS date,
        COUNT(*)::text AS referrals,
        COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit_volume,
        COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager_volume,
        COALESCE(SUM(referrer_cut_usd::numeric), 0)::text AS commission
      FROM affiliate_code_usages
      WHERE UPPER(code) = $1
      GROUP BY DATE(created_at)
      ORDER BY date
    `, uppercaseCode),
    db.$queryRawUnsafe<{ date: Date; clicks: string }[]>(`
      SELECT DATE(created_at) AS date, COUNT(*)::text AS clicks
      FROM affiliate_clicks
      WHERE code = $1
      GROUP BY DATE(created_at)
      ORDER BY date
    `, uppercaseCode),
    // Country breakdown scoped to THIS code.
    //  - Clicks: affiliate_clicks.country is the full country name populated
    //    by the geolocation service at track time. Clicks are always stored
    //    UPPERCASE.
    //  - Signups: derived from affiliate_code_usages.referred_user_id joined
    //    to user.country. Uses uppercaseCode for case-insensitive matching.
    //    casing). DISTINCT on referred_user_id so a user who made multiple
    //    usages under this code still counts once.
    db.$queryRawUnsafe<{ country: string; clicks: number; signups: number }[]>(
      `
      WITH click_countries AS (
        SELECT country, COUNT(*)::int AS clicks
        FROM affiliate_clicks
        WHERE code = $1
          AND country IS NOT NULL AND country <> 'unknown'
        GROUP BY country
      ),
      signup_countries AS (
        SELECT u.country, COUNT(DISTINCT acu.referred_user_id)::int AS signups
        FROM affiliate_code_usages acu
        JOIN "user" u ON u.id = acu.referred_user_id
        WHERE UPPER(acu.code) = $2
          AND u.country IS NOT NULL AND u.country <> ''
        GROUP BY u.country
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
      uppercaseCode,
      uppercaseCode,
    ),
    // Hourly acquisition series (last 24h, 24 buckets).
    //  - Clicks: affiliate_clicks, uppercase code (always uppercase stored).
    //  - Signups: affiliate_code_usages with usage_type='signup', uppercaseCode.
    // generate_series + LEFT JOIN guarantees continuous buckets even when
    // a given hour saw zero activity — chart renders flat bar, not a gap.
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
        WHERE code = $1
          AND created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY 1
      ),
      signups_agg AS (
        SELECT date_trunc('hour', created_at) AS bucket,
               COUNT(DISTINCT referred_user_id)::int AS n
        FROM affiliate_code_usages
        WHERE UPPER(code) = $2
          AND usage_type = 'signup'
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
      uppercaseCode,
      uppercaseCode,
    ),
    // Daily acquisition series (last 7d, 7 buckets). Same structure as
    // hourly but truncated to day.
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
        WHERE code = $1
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY 1
      ),
      signups_agg AS (
        SELECT date_trunc('day', created_at) AS bucket,
               COUNT(DISTINCT referred_user_id)::int AS n
        FROM affiliate_code_usages
        WHERE UPPER(code) = $2
          AND usage_type = 'signup'
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
      uppercaseCode,
      uppercaseCode,
    ),
  ]);

  const isActive = codeRecord.is_active;

  const totalReferrals = totalReferralsCount;
  const totalDeposits = usages.reduce((sum, u) => sum + toNumber(u.deposit_amount_usd), 0);
  const totalWagers = usages.reduce((sum, u) => sum + toNumber(u.wager_amount_usd), 0);
  const totalCommission = usages.reduce((sum, u) => sum + toNumber(u.referrer_cut_usd), 0);

  // Merge daily data. `DATE(created_at)` comes back from Prisma as either
  // a Date object or an ISO string depending on the driver; guard the
  // conversion so a null/invalid row never crashes the merge. Before the
  // uppercase-normalisation fix dailyClicks was always empty for lowercase
  // URLs and this defensive path was silently not exercised.
  const safeDateKey = (value: unknown): string | null => {
    if (value == null) return null;
    const d = value instanceof Date ? value : new Date(value as string);
    if (Number.isNaN(d.getTime())) return null;
    const iso = d.toISOString();
    const key = iso.split("T")[0];
    return key ?? null;
  };

  const clicksMap = new Map<string, number>();
  for (const d of dailyClicks) {
    const key = safeDateKey(d.date);
    if (key) clicksMap.set(key, Number(d.clicks));
  }

  const daily: {
    date: string;
    referrals: number;
    depositVolume: number;
    wagerVolume: number;
    commission: number;
    clicks: number;
  }[] = [];
  for (const d of dailyUsages) {
    const key = safeDateKey(d.date);
    if (!key) continue;
    daily.push({
      date: key,
      referrals: Number(d.referrals),
      depositVolume: toNumber(d.deposit_volume),
      wagerVolume: toNumber(d.wager_volume),
      commission: toNumber(d.commission),
      clicks: clicksMap.get(key) ?? 0,
    });
  }

  for (const [dateStr, clicks] of clicksMap) {
    if (!daily.find((d) => d.date === dateStr)) {
      daily.push({ date: dateStr, referrals: 0, depositVolume: 0, wagerVolume: 0, commission: 0, clicks });
    }
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    // Display the code exactly as stored in affiliate_codes (canonical
    // casing). URL param may arrive in any casing; this keeps the hero
    // consistent with the DB row.
    code: codeRecord.code,
    ownerUserId: codeRecord.user_id,
    ownerUsername: codeRecord.username ?? null,
    isActive,
    totalReferrals,
    totalDeposits,
    totalWagers,
    totalCommission,
    totalClicks: clickCount,
    daily,
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
    recentReferrals: usages.map((u) => ({
      id: u.id,
      referredUserId: u.referred_user_id,
      referredUsername: u.user_affiliate_code_usages_referred_user_idTouser?.username ?? null,
      usageType: u.usage_type,
      depositAmountUsd: toNumber(u.deposit_amount_usd),
      wagerAmountUsd: toNumber(u.wager_amount_usd),
      referrerCutUsd: toNumber(u.referrer_cut_usd),
      createdAt: u.created_at.toISOString(),
    })),
  };
}
