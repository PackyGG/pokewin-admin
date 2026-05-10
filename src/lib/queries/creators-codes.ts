import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import type { PaginatedResult } from "@/lib/types";
import type { CodeListItem } from "./creators-types";

// Prod has historically been ahead of / behind dev on schema changes, and
// missing tables / columns surface as PrismaClient errors that crash the
// whole route. Wrapping every query in `safe()` keeps the page rendering
// with empty values instead of a 500 — admins still see the static layout
// and any queries that DID succeed.
async function safe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    console.error("[creators-codes] query failed, using fallback:", err);
    return fallback;
  }
}

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

  const codeRows = await safe(
    db.$queryRawUnsafe<{ code: string; user_id: string; username: string | null }[]>(
      `SELECT ac.code, ac.user_id, u.username
       FROM affiliate_codes ac
       JOIN "user" u ON u.id = ac.user_id
       WHERE UPPER(ac.code) = $1
       LIMIT 1`,
      uppercaseCode,
    ),
    [] as { code: string; user_id: string; username: string | null }[],
  );
  const codeRecord = codeRows[0]
    ? { ...codeRows[0], is_active: true }
    : null;

  if (!codeRecord) return null;

  const [
    usages,
    usageAggRow,
    codeDepositTotalRow,
    clickCount,
    dailyUsages,
    dailyClicks,
    countryBreakdown,
    acquisitionHourly,
    acquisitionDaily,
  ] = await Promise.all([
    // Referrals table — one row per user who has ANY activity on this
    // code (signup, deposit, or wager). Aggregated so a single user with
    // 50 wager events shows up once with their cumulative volume; the
    // previous "one row per usage" view drowned the table in repeats and
    // hid users who deposited/wagered without a signup row (legacy
    // orphans whose recordSignupUsage hook had failed at registration).
    //
    // first_activity is treated as the join/signup date because backend
    // writes the signup row first, before any deposit/wager. has_signup
    // distinguishes "fully tracked" users from legacy orphans.
    safe(
      db.$queryRawUnsafe<
        {
          referred_user_id: string;
          referred_username: string | null;
          referred_email: string | null;
          first_activity: Date;
          last_activity: Date;
          total_deposits: string;
          total_wagers: string;
          total_commission: string;
          has_signup: boolean;
          active_elsewhere: boolean;
          event_count: string;
          code_deposit_total: string;
          code_deposit_count: string;
        }[]
      >(
        // active_elsewhere flags users who signed up via this code but
        // generated their deposit/wager volume on a *different* code —
        // they switched to another creator's code or typed a promo
        // code in. They're still this creator's referral but no
        // commission lands here, so the table surfaces them as a
        // distinct status rather than lumping them in with "Signup
        // only" (no activity at all) or "Active" (active here).
        //
        // code_deposit_total = the user's REAL deposit volume on this
        // code, summed from ledger_transactions.deposit_bonus events
        // (each one stores `deposit_usd` and `affiliate_code` in its
        // metadata at the moment the deposit fired, so a user who
        // switches codes gets each deposit booked against the code
        // that was active at the time). The `total_deposits` column
        // above only captures the FIRST deposit per user (backend's
        // trackFirstTimeDeposit gates on depositCount === 1) — which
        // is good for FTD reporting but understates the code's actual
        // economic contribution. Pairing the two lets the table show
        // "FTD $X / Total $Y" honestly.
        `SELECT acu.referred_user_id,
                u.username AS referred_username,
                u.email    AS referred_email,
                MIN(acu.created_at) AS first_activity,
                MAX(acu.created_at) AS last_activity,
                COALESCE(SUM(acu.deposit_amount_usd::numeric), 0)::text AS total_deposits,
                COALESCE(SUM(acu.wager_amount_usd::numeric),   0)::text AS total_wagers,
                COALESCE(SUM(acu.referrer_cut_usd::numeric),   0)::text AS total_commission,
                BOOL_OR(acu.usage_type = 'signup') AS has_signup,
                EXISTS (
                  SELECT 1 FROM affiliate_code_usages other
                  WHERE other.referred_user_id = acu.referred_user_id
                    AND UPPER(other.code) <> $1
                    AND other.usage_type IN ('deposit', 'wager')
                ) AS active_elsewhere,
                COUNT(*)::text AS event_count,
                COALESCE((
                  SELECT SUM((lt.metadata->>'deposit_usd')::numeric)
                  FROM ledger_transactions lt
                  WHERE lt.user_id = acu.referred_user_id
                    AND lt.type = 'deposit_bonus'
                    AND UPPER(lt.metadata->>'affiliate_code') = $1
                ), 0)::text AS code_deposit_total,
                COALESCE((
                  SELECT COUNT(*)
                  FROM ledger_transactions lt
                  WHERE lt.user_id = acu.referred_user_id
                    AND lt.type = 'deposit_bonus'
                    AND UPPER(lt.metadata->>'affiliate_code') = $1
                ), 0)::text AS code_deposit_count
           FROM affiliate_code_usages acu
           LEFT JOIN "user" u ON u.id = acu.referred_user_id
          WHERE UPPER(acu.code) = $1
          GROUP BY acu.referred_user_id, u.username, u.email
          ORDER BY MAX(acu.created_at) DESC
          LIMIT 50`,
        uppercaseCode,
      ),
      [] as {
        referred_user_id: string;
        referred_username: string | null;
        referred_email: string | null;
        first_activity: Date;
        last_activity: Date;
        total_deposits: string;
        total_wagers: string;
        total_commission: string;
        has_signup: boolean;
        active_elsewhere: boolean;
        event_count: string;
        code_deposit_total: string;
        code_deposit_count: string;
      }[],
    ),
    // Single batched aggregate against affiliate_code_usages. Replaces
    // 3 separate round-trips (signup count, active distinct, FTD/wager/
    // commission sums) with one scan + FILTER clauses. Same outer
    // filter (UPPER(code) = $1), same source of truth as before.
    //  - total_signups        = all rows with usage_type='signup'
    //  - active_referrals     = DISTINCT users with deposit/wager activity
    //  - total_deposits       = SUM(deposit_amount_usd) across all rows
    //                           (FTD-only by backend convention; the
    //                           ledger query below carries the full
    //                           deposit volume)
    //  - total_wagers         = SUM(wager_amount_usd)
    //  - total_commission     = SUM(referrer_cut_usd)
    safe(
      db.$queryRawUnsafe<{
        total_signups: string;
        active_referrals: string;
        total_deposits: string;
        total_wagers: string;
        total_commission: string;
      }[]>(
        `SELECT
           COUNT(*) FILTER (WHERE usage_type = 'signup')::text                           AS total_signups,
           COUNT(DISTINCT referred_user_id) FILTER (WHERE usage_type IN ('deposit', 'wager'))::text AS active_referrals,
           COALESCE(SUM(deposit_amount_usd::numeric), 0)::text                            AS total_deposits,
           COALESCE(SUM(wager_amount_usd::numeric), 0)::text                              AS total_wagers,
           COALESCE(SUM(referrer_cut_usd::numeric), 0)::text                              AS total_commission
         FROM affiliate_code_usages
         WHERE UPPER(code) = $1`,
        uppercaseCode,
      ),
      [] as {
        total_signups: string;
        active_referrals: string;
        total_deposits: string;
        total_wagers: string;
        total_commission: string;
      }[],
    ),
    // Real total deposit volume + counts on this code, derived from
    // ledger_transactions.deposit_bonus events whose metadata pins
    // the deposit to this affiliate_code. Backend writes one such
    // bonus event per deposit (not just the FTD), so this captures
    // the full economic value the code has driven — including users
    // who entered the code multiple times across separate deposits.
    //  - total              = SUM of deposit_usd across every event
    //  - deposit_event_count = number of deposits booked to this code
    //  - unique_depositors   = distinct users behind those deposits
    safe(
      db.$queryRawUnsafe<
        {
          total: string;
          deposit_event_count: string;
          unique_depositors: string;
        }[]
      >(
        `SELECT COALESCE(SUM((metadata->>'deposit_usd')::numeric), 0)::text AS total,
                COUNT(*)::text AS deposit_event_count,
                COUNT(DISTINCT user_id)::text AS unique_depositors
           FROM ledger_transactions
          WHERE type = 'deposit_bonus'
            AND UPPER(metadata->>'affiliate_code') = $1`,
        uppercaseCode,
      ),
      [] as {
        total: string;
        deposit_event_count: string;
        unique_depositors: string;
      }[],
    ),
    safe(db.affiliate_clicks.count({ where: { code: uppercaseCode } }), 0),
    safe(
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
          COUNT(*) FILTER (WHERE usage_type = 'signup')::text AS referrals,
          COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit_volume,
          COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager_volume,
          COALESCE(SUM(referrer_cut_usd::numeric), 0)::text AS commission
        FROM affiliate_code_usages
        WHERE UPPER(code) = $1
        GROUP BY DATE(created_at)
        ORDER BY date
      `, uppercaseCode),
      [] as {
        date: Date;
        referrals: string;
        deposit_volume: string;
        wager_volume: string;
        commission: string;
      }[],
    ),
    safe(
      db.$queryRawUnsafe<{ date: Date; clicks: string }[]>(`
        SELECT DATE(created_at) AS date, COUNT(*)::text AS clicks
        FROM affiliate_clicks
        WHERE code = $1
        GROUP BY DATE(created_at)
        ORDER BY date
      `, uppercaseCode),
      [] as { date: Date; clicks: string }[],
    ),
    // Country breakdown scoped to THIS code.
    //  - Clicks: affiliate_clicks.country is the full country name populated
    //    by the geolocation service at track time. Clicks are always stored
    //    UPPERCASE.
    //  - Signups: derived from affiliate_code_usages.referred_user_id joined
    //    to user.country. Uses uppercaseCode for case-insensitive matching.
    //    casing). DISTINCT on referred_user_id so a user who made multiple
    //    usages under this code still counts once.
    safe(
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
            AND acu.usage_type = 'signup'
            AND u.country IS NOT NULL AND u.country <> '' AND u.country <> 'unknown'
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
      [] as { country: string; clicks: number; signups: number }[],
    ),
    // Hourly acquisition series (last 24h, 24 buckets).
    //  - Clicks: affiliate_clicks, uppercase code (always uppercase stored).
    //  - Signups: affiliate_code_usages with usage_type='signup', uppercaseCode.
    // generate_series + LEFT JOIN guarantees continuous buckets even when
    // a given hour saw zero activity — chart renders flat bar, not a gap.
    safe(
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
      [] as { bucket: string; clicks: number; signups: number }[],
    ),
    // Daily acquisition series (last 7d, 7 buckets). Same structure as
    // hourly but truncated to day.
    safe(
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
      [] as { bucket: string; clicks: number; signups: number }[],
    ),
  ]);

  const isActive = codeRecord.is_active;

  const usageAggregate = usageAggRow[0];
  const totalReferrals = Number(usageAggregate?.total_signups ?? 0);
  const activeReferrals = Number(usageAggregate?.active_referrals ?? 0);
  const ftdDepositTotal = toNumber(usageAggregate?.total_deposits ?? 0);
  const codeDepositTotal = toNumber(codeDepositTotalRow[0]?.total ?? 0);
  const codeDepositEventCount = Number(
    codeDepositTotalRow[0]?.deposit_event_count ?? 0,
  );
  const codeUniqueDepositors = Number(
    codeDepositTotalRow[0]?.unique_depositors ?? 0,
  );
  const totalWagers = toNumber(usageAggregate?.total_wagers ?? 0);
  const totalCommission = toNumber(usageAggregate?.total_commission ?? 0);

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
    activeReferrals,
    totalDeposits: ftdDepositTotal,
    codeDepositTotal,
    codeDepositEventCount,
    codeUniqueDepositors,
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
      referredUserId: u.referred_user_id,
      referredUsername: u.referred_username ?? null,
      referredEmail: u.referred_email ?? null,
      firstActivityAt: u.first_activity.toISOString(),
      lastActivityAt: u.last_activity.toISOString(),
      ftdDepositUsd: toNumber(u.total_deposits),
      codeDepositTotalUsd: toNumber(u.code_deposit_total),
      codeDepositCount: Number(u.code_deposit_count),
      totalWagersUsd: toNumber(u.total_wagers),
      totalCommissionUsd: toNumber(u.total_commission),
      hasSignup: u.has_signup,
      activeElsewhere: u.active_elsewhere,
      eventCount: Number(u.event_count),
    })),
  };
}

// Slim referrals query for the creator detail page. Returns ONLY the
// columns that side panel actually renders (user, total wagers, total
// commission, last activity) — no per-row correlated subqueries for
// code_deposit_total / code_deposit_count, no active_elsewhere EXISTS
// scan, no has_signup. The full version in getCodeAnalytics fires
// 9 parallel queries and the usages query alone runs ~3 subqueries
// per row, which is why /creators/[id] was waiting on data the page
// then threw away. Use this when you only need the referrals list.
export async function getCodeReferrals(code: string, limit: number = 50) {
  const db = await getDb();
  const uppercaseCode = code.toUpperCase();
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn =
    excluded.length > 0
      ? `AND u.id NOT IN (${excluded.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
      : "";

  const rows = await safe(
    db.$queryRawUnsafe<
      {
        referred_user_id: string;
        referred_username: string | null;
        referred_email: string | null;
        last_activity: Date;
        total_wagers: string;
        total_commission: string;
      }[]
    >(
      `SELECT acu.referred_user_id,
              u.username AS referred_username,
              u.email    AS referred_email,
              MAX(acu.created_at) AS last_activity,
              COALESCE(SUM(acu.wager_amount_usd::numeric),   0)::text AS total_wagers,
              COALESCE(SUM(acu.referrer_cut_usd::numeric),   0)::text AS total_commission
         FROM affiliate_code_usages acu
         JOIN "user" u ON u.id = acu.referred_user_id
        WHERE UPPER(acu.code) = $1
          AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        GROUP BY acu.referred_user_id, u.username, u.email
        ORDER BY MAX(acu.created_at) DESC
        LIMIT ${safeLimit}`,
      uppercaseCode,
    ),
    [] as {
      referred_user_id: string;
      referred_username: string | null;
      referred_email: string | null;
      last_activity: Date;
      total_wagers: string;
      total_commission: string;
    }[],
  );

  return rows.map((r) => ({
    referredUserId: r.referred_user_id,
    referredUsername: r.referred_username,
    referredEmail: r.referred_email,
    lastActivityAt: r.last_activity.toISOString(),
    totalWagersUsd: toNumber(r.total_wagers),
    totalCommissionUsd: toNumber(r.total_commission),
  }));
}

// Recent wager events from users tied to this affiliate code. Used by
// the creator detail page to surface a chronological feed of activity
// happening on the code right now (the per-user totals already live on
// `recentReferrals`; this complements that with an event-level view).
//
// Source set: every user with at least one row in affiliate_code_usages
// for this code (signup, deposit, or wager event). That matches the
// referrals table on the same page so the wager feed and the referral
// list agree on the population.
//
// We pull the standard wager types — pack_opening, battle_bet,
// battle_sponsorship — exactly as analytics-cohorts/analytics-top do,
// gated to status='completed' so failed/pending bets don't spam the
// feed. amount is stored as a negative number (debit from the user's
// balance), so we ABS it for display — the table reads as
// "user X bet $Y" not "user X bet -$Y".
export async function getRecentWagersOnCode(
  code: string,
  limit: number = 25,
) {
  const db = await getDb();
  const uppercaseCode = code.toUpperCase();
  // Cap and floor the limit so a buggy caller can't fetch the world.
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const excludedRecent = await getExcludedUserIds();
  const blacklistIdNotIn =
    excludedRecent.length > 0
      ? `AND u.id NOT IN (${excludedRecent.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
      : "";

  const rows = await safe(
    db.$queryRawUnsafe<
      {
        id: string;
        user_id: string;
        username: string | null;
        email: string | null;
        type: string;
        amount: string;
        created_at: Date;
      }[]
    >(
      `WITH code_users AS (
         SELECT DISTINCT acu.referred_user_id
         FROM affiliate_code_usages acu
         JOIN "user" u ON u.id = acu.referred_user_id
         WHERE UPPER(acu.code) = $1
           AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
       )
       SELECT
         lt.id,
         lt.user_id,
         u.username,
         u.email,
         lt.type::text AS type,
         lt.amount::text AS amount,
         lt.created_at
       FROM ledger_transactions lt
       JOIN code_users cu ON cu.referred_user_id = lt.user_id
       LEFT JOIN "user" u ON u.id = lt.user_id
       WHERE lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
         AND lt.status = 'completed'
       ORDER BY lt.created_at DESC
       LIMIT ${safeLimit}`,
      uppercaseCode,
    ),
    [] as {
      id: string;
      user_id: string;
      username: string | null;
      email: string | null;
      type: string;
      amount: string;
      created_at: Date;
    }[],
  );

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    email: r.email,
    type: r.type as "pack_opening" | "battle_bet" | "battle_sponsorship",
    // amount is negative on the user's ledger (money leaving their
    // balance); display as a positive bet figure.
    amountUsd: Math.abs(toNumber(r.amount)),
    createdAt: r.created_at.toISOString(),
  }));
}
