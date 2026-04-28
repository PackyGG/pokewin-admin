import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { MS_PER_DAY } from "@/lib/utils/time";

/**
 * Queries for the /creators/ads feature. Ad codes are plain
 * `affiliate_codes` rows owned by a single "house" user that the admin
 * designates via the admin_settings table. Everything else — clicks,
 * signups, depositor usages — already flows through the existing
 * affiliate infrastructure.
 *
 * Signup tracking source-of-truth: `affiliate_code_usages` rows where
 * `usage_type = 'signup'`. This is the canonical, transactional record
 * the backend writes alongside `user.referred_by`. We previously read
 * signups off `user.referred_by + user.affiliate_code`, which silently
 * undercounted whenever the recordSignupUsage hook had failed (we found
 * ~28 such cases historically). Reading from `affiliate_code_usages`
 * keeps this page aligned with /creators/codes/[code] and the wider
 * affiliate dashboard.
 *
 * Code casing: affiliate_clicks is always uppercase (trackClick
 * normalises). affiliate_codes/usages store mixed casing for legacy
 * rows. Every query here therefore matches case-insensitively
 * (UPPER/LOWER on both sides) so a code that landed lowercase in one
 * table still aligns with its uppercase sibling in another.
 */

// Production schema occasionally lags behind dev — when a missing
// table/column would otherwise crash the page, fall back to an empty
// result so the layout still renders. Errors are still logged so we
// notice silent regressions instead of acting on partial data forever.
async function safe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    console.error("[ads] query failed, using fallback:", err);
    return fallback;
  }
}

export type AdCodeSummary = {
  code: string;
  createdAt: string;
  clicks: number;
  signups: number;
  /** Signed-up users on this code who later deposited or wagered. */
  activeReferrals: number;
  depositors: number;
  depositVolumeUsd: number;
  wagerVolumeUsd: number;
  /** signups / clicks (0-1). 0 when no clicks yet. */
  conversionRate: number;
};

export type AdAggregate = {
  totalCodes: number;
  totalClicks: number;
  totalSignups: number;
  totalActiveReferrals: number;
  totalDepositors: number;
  totalDepositVolumeUsd: number;
  totalWagerVolumeUsd: number;
};

export type AdCodeClicksByDay = { date: string; clicks: number };
export type AdCodeClicksByCountry = { country: string; clicks: number };

export type AdCodeSignup = {
  userId: string;
  username: string | null;
  email: string | null;
  createdAt: string;
  totalDepositedUsd: number;
  isFtd: boolean;
};

export type AdCodeDetail = {
  code: string;
  createdAt: string;
  summary: AdCodeSummary;
  clicksByDay: AdCodeClicksByDay[];
  clicksByCountry: AdCodeClicksByCountry[];
  signupsList: AdCodeSignup[];
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Returns a summary row for every affiliate code owned by the house user.
 * Signups are scoped to the specific ad code (user.referred_by =
 * houseUserId AND user.affiliate_code = code) so one code getting
 * traffic doesn't inflate another code's count.
 */
export async function getAdCodes(houseUserId: string): Promise<AdCodeSummary[]> {
  const db = await getDb();
  const codes = await safe(
    db.affiliate_codes.findMany({
      where: { user_id: houseUserId },
      select: { code: true, created_at: true },
      orderBy: { created_at: "desc" },
    }),
    [] as { code: string; created_at: Date }[],
  );
  if (codes.length === 0) return [];

  const codeList = codes.map((c) => c.code);
  const upperCodeList = codeList.map((c) => c.toUpperCase());

  // All per-code aggregates run in parallel. Every match is
  // UPPER(...) = UPPER(...) so a mixed-case `affiliate_codes` row still
  // matches the always-uppercase clicks and the mixed-case usages rows.
  const [
    clickRowsRaw,
    signupRows,
    activeRows,
    usageAggByCode,
    depositorRows,
  ] = await Promise.all([
    safe(
      db.$queryRawUnsafe<{ code_upper: string; count: string }[]>(
        `SELECT UPPER(code) AS code_upper, COUNT(*)::text AS count
           FROM affiliate_clicks
          WHERE UPPER(code) = ANY($1::text[])
          GROUP BY UPPER(code)`,
        upperCodeList,
      ),
      [] as { code_upper: string; count: string }[],
    ),
    // Signups — canonical from affiliate_code_usages. Distinct user
    // count so a duplicated row never inflates.
    safe(
      db.$queryRawUnsafe<{ code_upper: string; count: string }[]>(
        `SELECT UPPER(code) AS code_upper,
                COUNT(DISTINCT referred_user_id)::text AS count
           FROM affiliate_code_usages
          WHERE affiliate_user_id = $1
            AND UPPER(code) = ANY($2::text[])
            AND usage_type = 'signup'
          GROUP BY UPPER(code)`,
        houseUserId,
        upperCodeList,
      ),
      [] as { code_upper: string; count: string }[],
    ),
    // Active referrals — signed-up users who also generated deposit or
    // wager activity on the same code. Lets the list page surface the
    // "X active" subtitle alongside total signups.
    safe(
      db.$queryRawUnsafe<{ code_upper: string; count: string }[]>(
        `SELECT UPPER(s.code) AS code_upper,
                COUNT(DISTINCT s.referred_user_id)::text AS count
           FROM affiliate_code_usages s
          WHERE s.affiliate_user_id = $1
            AND UPPER(s.code) = ANY($2::text[])
            AND s.usage_type = 'signup'
            AND EXISTS (
              SELECT 1 FROM affiliate_code_usages a
              WHERE a.referred_user_id = s.referred_user_id
                AND UPPER(a.code) = UPPER(s.code)
                AND a.usage_type IN ('deposit', 'wager')
            )
          GROUP BY UPPER(s.code)`,
        houseUserId,
        upperCodeList,
      ),
      [] as { code_upper: string; count: string }[],
    ),
    safe(
      db.$queryRawUnsafe<{
        code_upper: string;
        deposit: string;
        wager: string;
      }[]>(
        `SELECT UPPER(code) AS code_upper,
                COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit,
                COALESCE(SUM(wager_amount_usd::numeric), 0)::text   AS wager
           FROM affiliate_code_usages
          WHERE affiliate_user_id = $1
            AND UPPER(code) = ANY($2::text[])
          GROUP BY UPPER(code)`,
        houseUserId,
        upperCodeList,
      ),
      [] as { code_upper: string; deposit: string; wager: string }[],
    ),
    safe(
      db.$queryRawUnsafe<{ code_upper: string; count: string }[]>(
        `SELECT UPPER(code) AS code_upper,
                COUNT(DISTINCT referred_user_id)::text AS count
           FROM affiliate_code_usages
          WHERE affiliate_user_id = $1
            AND UPPER(code) = ANY($2::text[])
            AND usage_type = 'deposit'
          GROUP BY UPPER(code)`,
        houseUserId,
        upperCodeList,
      ),
      [] as { code_upper: string; count: string }[],
    ),
  ]);

  const clickMap = new Map(
    clickRowsRaw.map((r) => [r.code_upper, Number(r.count)]),
  );
  const signupMap = new Map(
    signupRows.map((r) => [r.code_upper, Number(r.count)]),
  );
  const activeMap = new Map(
    activeRows.map((r) => [r.code_upper, Number(r.count)]),
  );
  const usageMap = new Map(
    usageAggByCode.map((r) => [
      r.code_upper,
      { deposit: toNumber(r.deposit), wager: toNumber(r.wager) },
    ]),
  );
  const depositorMap = new Map(
    depositorRows.map((r) => [r.code_upper, Number(r.count)]),
  );

  return codes.map((c) => {
    const key = c.code.toUpperCase();
    const clicks = clickMap.get(key) ?? 0;
    const signups = signupMap.get(key) ?? 0;
    const activeReferrals = activeMap.get(key) ?? 0;
    const usage = usageMap.get(key) ?? { deposit: 0, wager: 0 };
    const depositors = depositorMap.get(key) ?? 0;
    return {
      code: c.code,
      createdAt: c.created_at.toISOString(),
      clicks,
      signups,
      activeReferrals,
      depositors,
      depositVolumeUsd: usage.deposit,
      wagerVolumeUsd: usage.wager,
      conversionRate: clicks > 0 ? signups / clicks : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export async function getAdCodesAggregate(
  houseUserId: string,
): Promise<AdAggregate> {
  const db = await getDb();
  const codeRows = await safe(
    db.affiliate_codes.findMany({
      where: { user_id: houseUserId },
      select: { code: true },
    }),
    [] as { code: string }[],
  );
  const codeList = codeRows.map((c) => c.code);
  const totalCodes = codeList.length;

  if (totalCodes === 0) {
    return {
      totalCodes: 0,
      totalClicks: 0,
      totalSignups: 0,
      totalActiveReferrals: 0,
      totalDepositors: 0,
      totalDepositVolumeUsd: 0,
      totalWagerVolumeUsd: 0,
    };
  }

  const upperCodeList = codeList.map((c) => c.toUpperCase());

  const [clicksRow, signupsRow, activeRow, depositorRow, sumsRow] =
    await Promise.all([
      safe(
        db.$queryRawUnsafe<{ count: string }[]>(
          `SELECT COUNT(*)::text AS count
             FROM affiliate_clicks
            WHERE UPPER(code) = ANY($1::text[])`,
          upperCodeList,
        ),
        [] as { count: string }[],
      ),
      // Signups from the canonical usages table — same source of truth
      // used everywhere else, so totals stay aligned across pages.
      safe(
        db.$queryRawUnsafe<{ count: string }[]>(
          `SELECT COUNT(DISTINCT referred_user_id)::text AS count
             FROM affiliate_code_usages
            WHERE affiliate_user_id = $1
              AND UPPER(code) = ANY($2::text[])
              AND usage_type = 'signup'`,
          houseUserId,
          upperCodeList,
        ),
        [] as { count: string }[],
      ),
      safe(
        db.$queryRawUnsafe<{ count: string }[]>(
          `SELECT COUNT(DISTINCT s.referred_user_id)::text AS count
             FROM affiliate_code_usages s
            WHERE s.affiliate_user_id = $1
              AND UPPER(s.code) = ANY($2::text[])
              AND s.usage_type = 'signup'
              AND EXISTS (
                SELECT 1 FROM affiliate_code_usages a
                WHERE a.referred_user_id = s.referred_user_id
                  AND UPPER(a.code) = UPPER(s.code)
                  AND a.usage_type IN ('deposit', 'wager')
              )`,
          houseUserId,
          upperCodeList,
        ),
        [] as { count: string }[],
      ),
      safe(
        db.$queryRawUnsafe<{ count: string }[]>(
          `SELECT COUNT(DISTINCT referred_user_id)::text AS count
             FROM affiliate_code_usages
            WHERE affiliate_user_id = $1
              AND UPPER(code) = ANY($2::text[])
              AND usage_type = 'deposit'`,
          houseUserId,
          upperCodeList,
        ),
        [] as { count: string }[],
      ),
      safe(
        db.$queryRawUnsafe<{ deposit: string; wager: string }[]>(
          `SELECT COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit,
                  COALESCE(SUM(wager_amount_usd::numeric),   0)::text AS wager
             FROM affiliate_code_usages
            WHERE affiliate_user_id = $1
              AND UPPER(code) = ANY($2::text[])`,
          houseUserId,
          upperCodeList,
        ),
        [] as { deposit: string; wager: string }[],
      ),
    ]);

  return {
    totalCodes,
    totalClicks: Number(clicksRow[0]?.count ?? 0),
    totalSignups: Number(signupsRow[0]?.count ?? 0),
    totalActiveReferrals: Number(activeRow[0]?.count ?? 0),
    totalDepositors: Number(depositorRow[0]?.count ?? 0),
    totalDepositVolumeUsd: toNumber(sumsRow[0]?.deposit ?? 0),
    totalWagerVolumeUsd: toNumber(sumsRow[0]?.wager ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Per-code detail
// ---------------------------------------------------------------------------

export async function getAdCodeDetail(
  houseUserId: string,
  code: string,
): Promise<AdCodeDetail | null> {
  const db = await getDb();
  // Code lookup is case-insensitive — affiliate_codes has mixed casing
  // for legacy rows, but the URL slug always reaches us in some casing
  // and we shouldn't 404 just because of that mismatch.
  const recordRows = await safe(
    db.$queryRawUnsafe<{ code: string; created_at: Date }[]>(
      `SELECT code, created_at
         FROM affiliate_codes
        WHERE user_id = $1
          AND UPPER(code) = UPPER($2)
        LIMIT 1`,
      houseUserId,
      code,
    ),
    [] as { code: string; created_at: Date }[],
  );
  const record = recordRows[0];
  if (!record) return null;

  const upperCode = record.code.toUpperCase();
  const now = new Date();
  // Last 30 days inclusive of today.
  const thirtyDaysAgo = new Date(now.getTime() - 29 * MS_PER_DAY);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

  const [
    clicksCount,
    signupsCount,
    activeReferralsRow,
    depositorRows,
    usageSums,
    clicksByDayRows,
    clicksByCountryRows,
    signupsRaw,
  ] = await Promise.all([
    safe(
      db.$queryRawUnsafe<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count
           FROM affiliate_clicks
          WHERE UPPER(code) = $1`,
        upperCode,
      ),
      [] as { count: string }[],
    ),
    // Canonical signup count from affiliate_code_usages.
    safe(
      db.$queryRawUnsafe<{ count: string }[]>(
        `SELECT COUNT(DISTINCT referred_user_id)::text AS count
           FROM affiliate_code_usages
          WHERE affiliate_user_id = $1
            AND UPPER(code) = $2
            AND usage_type = 'signup'`,
        houseUserId,
        upperCode,
      ),
      [] as { count: string }[],
    ),
    safe(
      db.$queryRawUnsafe<{ count: string }[]>(
        `SELECT COUNT(DISTINCT s.referred_user_id)::text AS count
           FROM affiliate_code_usages s
          WHERE s.affiliate_user_id = $1
            AND UPPER(s.code) = $2
            AND s.usage_type = 'signup'
            AND EXISTS (
              SELECT 1 FROM affiliate_code_usages a
              WHERE a.referred_user_id = s.referred_user_id
                AND UPPER(a.code) = $2
                AND a.usage_type IN ('deposit', 'wager')
            )`,
        houseUserId,
        upperCode,
      ),
      [] as { count: string }[],
    ),
    safe(
      db.$queryRawUnsafe<{ count: string }[]>(
        `SELECT COUNT(DISTINCT referred_user_id)::text AS count
           FROM affiliate_code_usages
          WHERE affiliate_user_id = $1
            AND UPPER(code) = $2
            AND usage_type = 'deposit'`,
        houseUserId,
        upperCode,
      ),
      [] as { count: string }[],
    ),
    safe(
      db.$queryRawUnsafe<{ deposit: string; wager: string }[]>(
        `SELECT COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit,
                COALESCE(SUM(wager_amount_usd::numeric),   0)::text AS wager
           FROM affiliate_code_usages
          WHERE affiliate_user_id = $1
            AND UPPER(code) = $2`,
        houseUserId,
        upperCode,
      ),
      [] as { deposit: string; wager: string }[],
    ),
    safe(
      db.$queryRawUnsafe<{ date: string; clicks: string }[]>(
        `SELECT TO_CHAR(DATE_TRUNC('day', created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
                COUNT(*)::text AS clicks
           FROM affiliate_clicks
          WHERE UPPER(code) = $1
            AND created_at >= $2
          GROUP BY DATE_TRUNC('day', created_at)
          ORDER BY DATE_TRUNC('day', created_at) ASC`,
        upperCode,
        thirtyDaysAgo,
      ),
      [] as { date: string; clicks: string }[],
    ),
    safe(
      db.$queryRawUnsafe<{ country: string; clicks: string }[]>(
        `SELECT country, COUNT(*)::text AS clicks
           FROM affiliate_clicks
          WHERE UPPER(code) = $1
          GROUP BY country
          ORDER BY COUNT(*) DESC
          LIMIT 10`,
        upperCode,
      ),
      [] as { country: string; clicks: string }[],
    ),
    // Signup list — pulled from affiliate_code_usages so we capture
    // every transactional signup event, not just users whose
    // referred_by/affiliate_code happens to still match. JOIN user for
    // username/email; use MIN(created_at) so a user with multiple
    // backfilled signup rows still shows up exactly once.
    safe(
      db.$queryRawUnsafe<
        {
          user_id: string;
          username: string | null;
          email: string | null;
          created_at: Date;
        }[]
      >(
        `SELECT acu.referred_user_id AS user_id,
                u.username,
                u.email,
                MIN(acu.created_at) AS created_at
           FROM affiliate_code_usages acu
           LEFT JOIN "user" u ON u.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = $1
            AND UPPER(acu.code) = $2
            AND acu.usage_type = 'signup'
          GROUP BY acu.referred_user_id, u.username, u.email
          ORDER BY MIN(acu.created_at) DESC
          LIMIT 100`,
        houseUserId,
        upperCode,
      ),
      [] as {
        user_id: string;
        username: string | null;
        email: string | null;
        created_at: Date;
      }[],
    ),
  ]);

  const signupUserIds = signupsRaw.map((s) => s.user_id);
  const balances = signupUserIds.length
    ? await safe(
        db.balances.findMany({
          where: { user_id: { in: signupUserIds } },
          select: { user_id: true, total_deposited: true },
        }),
        [] as { user_id: string; total_deposited: unknown }[],
      )
    : [];
  const balanceMap = new Map(
    balances.map((b) => [b.user_id, toNumber(b.total_deposited)]),
  );

  // Build a contiguous 30-day series so the chart doesn't render gaps
  // on zero-click days.
  const dayMap = new Map(clicksByDayRows.map((r) => [r.date, Number(r.clicks)]));
  const clicksByDay: AdCodeClicksByDay[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo.getTime() + i * MS_PER_DAY);
    const key = d.toISOString().slice(0, 10);
    clicksByDay.push({ date: key, clicks: dayMap.get(key) ?? 0 });
  }

  const clicksCountNum = Number(clicksCount[0]?.count ?? 0);
  const signupsCountNum = Number(signupsCount[0]?.count ?? 0);
  const summary: AdCodeSummary = {
    code: record.code,
    createdAt: record.created_at.toISOString(),
    clicks: clicksCountNum,
    signups: signupsCountNum,
    activeReferrals: Number(activeReferralsRow[0]?.count ?? 0),
    depositors: Number(depositorRows[0]?.count ?? 0),
    depositVolumeUsd: toNumber(usageSums[0]?.deposit ?? 0),
    wagerVolumeUsd: toNumber(usageSums[0]?.wager ?? 0),
    conversionRate: clicksCountNum > 0 ? signupsCountNum / clicksCountNum : 0,
  };

  return {
    code: record.code,
    createdAt: record.created_at.toISOString(),
    summary,
    clicksByDay,
    clicksByCountry: clicksByCountryRows.map((r) => ({
      country: r.country,
      clicks: Number(r.clicks),
    })),
    signupsList: signupsRaw.map((s) => {
      const deposited = balanceMap.get(s.user_id) ?? 0;
      return {
        userId: s.user_id,
        username: s.username,
        email: s.email,
        createdAt: s.created_at.toISOString(),
        totalDepositedUsd: deposited,
        isFtd: deposited > 0,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// House user lookup — resolves the configured house user id to a
// display-friendly payload for the header.
// ---------------------------------------------------------------------------

export async function getHouseUserInfo(
  houseUserId: string,
): Promise<{ id: string; username: string | null; email: string | null } | null> {
  const db = await getDb();
  const user = await safe(
    db.user.findUnique({
      where: { id: houseUserId },
      select: { id: true, username: true, email: true },
    }),
    null,
  );
  return user ?? null;
}
