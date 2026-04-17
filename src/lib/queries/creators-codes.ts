import { db } from "@/lib/db";
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
  const [
    codeRecord,
    usages,
    clickCount,
    dailyUsages,
    dailyClicks,
  ] = await Promise.all([
    db.$queryRawUnsafe<{ user_id: string; username: string | null }[]>(
      `SELECT ac.user_id, u.username
       FROM affiliate_codes ac
       JOIN "user" u ON u.id = ac.user_id
       WHERE ac.code = $1
       LIMIT 1`,
      code
    ).then((rows) => rows[0] ? { ...rows[0], is_active: true } : null),
    db.affiliate_code_usages.findMany({
      where: { code },
      include: {
        user_affiliate_code_usages_referred_user_idTouser: {
          select: { username: true },
        },
      },
      orderBy: { created_at: "desc" },
      take: 50,
    }),
    db.affiliate_clicks.count({ where: { code } }),
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
      WHERE code = $1
      GROUP BY DATE(created_at)
      ORDER BY date
    `, code),
    db.$queryRawUnsafe<{ date: Date; clicks: string }[]>(`
      SELECT DATE(created_at) AS date, COUNT(*)::text AS clicks
      FROM affiliate_clicks
      WHERE code = $1
      GROUP BY DATE(created_at)
      ORDER BY date
    `, code),
  ]);

  if (!codeRecord) return null;

  const isActive = codeRecord.is_active;

  const totalReferrals = usages.length;
  const totalDeposits = usages.reduce((sum, u) => sum + toNumber(u.deposit_amount_usd), 0);
  const totalWagers = usages.reduce((sum, u) => sum + toNumber(u.wager_amount_usd), 0);
  const totalCommission = usages.reduce((sum, u) => sum + toNumber(u.referrer_cut_usd), 0);

  // Merge daily data
  const clicksMap = new Map(
    dailyClicks.map((d) => [new Date(d.date).toISOString().split("T")[0], Number(d.clicks)])
  );

  const daily = dailyUsages.map((d) => {
    const dateStr = new Date(d.date).toISOString().split("T")[0];
    return {
      date: dateStr,
      referrals: Number(d.referrals),
      depositVolume: toNumber(d.deposit_volume),
      wagerVolume: toNumber(d.wager_volume),
      commission: toNumber(d.commission),
      clicks: clicksMap.get(dateStr) ?? 0,
    };
  });

  for (const [dateStr, clicks] of clicksMap) {
    if (!daily.find((d) => d.date === dateStr)) {
      daily.push({ date: dateStr, referrals: 0, depositVolume: 0, wagerVolume: 0, commission: 0, clicks });
    }
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    code,
    ownerUserId: codeRecord.user_id,
    ownerUsername: codeRecord.username ?? null,
    isActive,
    totalReferrals,
    totalDeposits,
    totalWagers,
    totalCommission,
    totalClicks: clickCount,
    daily,
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
