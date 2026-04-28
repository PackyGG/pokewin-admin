import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { MS_PER_DAY } from "@/lib/utils/time";

/**
 * Queries for the /creators/ads feature. Ad codes are plain
 * `affiliate_codes` rows owned by a single "house" user that the admin
 * designates via the admin_settings table. Everything else — clicks,
 * signups (user.referred_by = house_user_id), and depositor usages —
 * already flows through the existing affiliate infrastructure.
 *
 * Patterns mirror getCreatorDetail so metrics stay consistent across
 * the creators + ads pages (clicks come from affiliate_clicks.code,
 * signups from user.referred_by AND user.affiliate_code to scope to
 * the specific ad code, depositors from distinct referred_user_id in
 * affiliate_code_usages).
 */

export type AdCodeSummary = {
  code: string;
  createdAt: string;
  clicks: number;
  signups: number;
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
  const codes = await db.affiliate_codes.findMany({
    where: { user_id: houseUserId },
    select: { code: true, created_at: true },
    orderBy: { created_at: "desc" },
  });
  if (codes.length === 0) return [];

  const codeList = codes.map((c) => c.code);

  // Parallelize all the aggregate queries across every code, then slot
  // the results into each summary entry.
  // Case-insensitive click match: the main site may normalise the code
  // before writing to affiliate_clicks (lowercase is common), which
  // would make `code = 'FBADS_JAN'` miss rows stored as `fbads_jan`.
  // Raw SQL with LOWER() on both sides keeps the query correct no
  // matter which case the site writes.
  const lowerCodeList = codeList.map((c) => c.toLowerCase());
  const [
    clickRowsRaw,
    signupRows,
    usageAggByCode,
  ] = await Promise.all([
    db.$queryRawUnsafe<{ code_lower: string; count: string }[]>(
      `SELECT LOWER(code) AS code_lower, COUNT(*)::text AS count
         FROM affiliate_clicks
        WHERE LOWER(code) = ANY($1::text[])
        GROUP BY LOWER(code)`,
      lowerCodeList,
    ),
    db.user.groupBy({
      by: ["affiliate_code"],
      where: {
        referred_by: houseUserId,
        affiliate_code: { in: codeList },
      },
      _count: { _all: true },
    }),
    db.affiliate_code_usages.groupBy({
      by: ["code"],
      where: {
        affiliate_user_id: houseUserId,
        code: { in: codeList },
      },
      _sum: {
        deposit_amount_usd: true,
        wager_amount_usd: true,
      },
    }),
  ]);

  // Depositors = DISTINCT referred_user_id per code where usage_type =
  // 'deposit'. Without this filter, signup-type rows are included and
  // inflate the count to equal the signup count.
  const depositorRows = await db.$queryRawUnsafe<
    { code: string; count: string }[]
  >(
    `SELECT code, COUNT(DISTINCT referred_user_id)::text AS count
       FROM affiliate_code_usages
      WHERE affiliate_user_id = $1
        AND code = ANY($2::text[])
        AND usage_type = 'deposit'
      GROUP BY code`,
    houseUserId,
    codeList,
  );

  // clickMap is keyed by LOWER(code) so lookups must lowercase before
  // indexing. The admin DB row keeps its original casing for display.
  const clickMap = new Map(
    clickRowsRaw.map((r) => [r.code_lower, Number(r.count)]),
  );
  const signupMap = new Map(
    signupRows
      .filter((r): r is typeof r & { affiliate_code: string } =>
        r.affiliate_code != null,
      )
      .map((r) => [r.affiliate_code, r._count._all]),
  );
  const usageMap = new Map(
    usageAggByCode.map((r) => [
      r.code,
      {
        deposit: toNumber(r._sum.deposit_amount_usd),
        wager: toNumber(r._sum.wager_amount_usd),
      },
    ]),
  );
  const depositorMap = new Map(
    depositorRows.map((r) => [r.code, Number(r.count)]),
  );

  return codes.map((c) => {
    const clicks = clickMap.get(c.code.toLowerCase()) ?? 0;
    const signups = signupMap.get(c.code) ?? 0;
    const usage = usageMap.get(c.code) ?? { deposit: 0, wager: 0 };
    const depositors = depositorMap.get(c.code) ?? 0;
    return {
      code: c.code,
      createdAt: c.created_at.toISOString(),
      clicks,
      signups,
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
  const codeRows = await db.affiliate_codes.findMany({
    where: { user_id: houseUserId },
    select: { code: true },
  });
  const codeList = codeRows.map((c) => c.code);
  const totalCodes = codeList.length;

  if (totalCodes === 0) {
    return {
      totalCodes: 0,
      totalClicks: 0,
      totalSignups: 0,
      totalDepositors: 0,
      totalDepositVolumeUsd: 0,
      totalWagerVolumeUsd: 0,
    };
  }

  const [clicks, signups, depositorRows, usageAgg] = await Promise.all([
    db.affiliate_clicks.count({ where: { code: { in: codeList } } }),
    // Scope to codes owned by the house user so any manual referred_by
    // assignments on the same account don't leak into the total.
    db.user.count({
      where: {
        referred_by: houseUserId,
        affiliate_code: { in: codeList },
      },
    }),
    db.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(DISTINCT referred_user_id)::text AS count
         FROM affiliate_code_usages
        WHERE affiliate_user_id = $1
          AND code = ANY($2::text[])
          AND usage_type = 'deposit'`,
      houseUserId,
      codeList,
    ),
    db.affiliate_code_usages.aggregate({
      where: {
        affiliate_user_id: houseUserId,
        code: { in: codeList },
      },
      _sum: {
        deposit_amount_usd: true,
        wager_amount_usd: true,
      },
    }),
  ]);

  return {
    totalCodes,
    totalClicks: clicks,
    totalSignups: signups,
    totalDepositors: Number(depositorRows[0]?.count ?? 0),
    totalDepositVolumeUsd: toNumber(usageAgg._sum.deposit_amount_usd),
    totalWagerVolumeUsd: toNumber(usageAgg._sum.wager_amount_usd),
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
  const record = await db.affiliate_codes.findFirst({
    where: { user_id: houseUserId, code },
    select: { code: true, created_at: true },
  });
  if (!record) return null;

  const now = new Date();
  // Last 30 days inclusive of today.
  const thirtyDaysAgo = new Date(now.getTime() - 29 * MS_PER_DAY);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

  const [
    clicksCount,
    signupsCount,
    depositorRows,
    usageAgg,
    clicksByDayRows,
    clicksByCountryRows,
    signups,
  ] = await Promise.all([
    // Case-insensitive — main site may normalise code casing before
    // writing click rows, which would hide them from an exact match.
    db.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM affiliate_clicks WHERE LOWER(code) = LOWER($1)`,
      code,
    ),
    db.user.count({
      where: { referred_by: houseUserId, affiliate_code: code },
    }),
    db.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(DISTINCT referred_user_id)::text AS count
         FROM affiliate_code_usages
        WHERE affiliate_user_id = $1
          AND code = $2
          AND usage_type = 'deposit'`,
      houseUserId,
      code,
    ),
    db.affiliate_code_usages.aggregate({
      where: { affiliate_user_id: houseUserId, code },
      _sum: {
        deposit_amount_usd: true,
        wager_amount_usd: true,
      },
    }),
    db.$queryRawUnsafe<{ date: string; clicks: string }[]>(
      `SELECT TO_CHAR(DATE_TRUNC('day', created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
              COUNT(*)::text AS clicks
         FROM affiliate_clicks
        WHERE LOWER(code) = LOWER($1)
          AND created_at >= $2
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY DATE_TRUNC('day', created_at) ASC`,
      code,
      thirtyDaysAgo,
    ),
    db.$queryRawUnsafe<{ country: string; clicks: string }[]>(
      `SELECT country, COUNT(*)::text AS clicks
         FROM affiliate_clicks
        WHERE LOWER(code) = LOWER($1)
        GROUP BY country
        ORDER BY COUNT(*) DESC
        LIMIT 10`,
      code,
    ),
    db.user.findMany({
      where: { referred_by: houseUserId, affiliate_code: code },
      select: {
        id: true,
        username: true,
        email: true,
        created_at: true,
      },
      orderBy: { created_at: "desc" },
      take: 100,
    }),
  ]);

  const signupUserIds = signups.map((s) => s.id);
  const balances = signupUserIds.length
    ? await db.balances.findMany({
        where: { user_id: { in: signupUserIds } },
        select: { user_id: true, total_deposited: true },
      })
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
  const summary: AdCodeSummary = {
    code: record.code,
    createdAt: record.created_at.toISOString(),
    clicks: clicksCountNum,
    signups: signupsCount,
    depositors: Number(depositorRows[0]?.count ?? 0),
    depositVolumeUsd: toNumber(usageAgg._sum.deposit_amount_usd),
    wagerVolumeUsd: toNumber(usageAgg._sum.wager_amount_usd),
    conversionRate: clicksCountNum > 0 ? signupsCount / clicksCountNum : 0,
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
    signupsList: signups.map((s) => {
      const deposited = balanceMap.get(s.id) ?? 0;
      return {
        userId: s.id,
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
  const user = await db.user.findUnique({
    where: { id: houseUserId },
    select: { id: true, username: true, email: true },
  });
  return user ?? null;
}
