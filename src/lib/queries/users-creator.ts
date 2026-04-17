import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";

export async function getCreatorReferralClicks(
  affiliateCode: string,
  page: number = 1,
  perPage: number = 20
): Promise<PaginatedResult<{
  id: number;
  code: string;
  userAgent: string | null;
  ip: string;
  country: string;
  region: string;
  city: string;
  createdAt: string | null;
}>> {
  const where = { code: affiliateCode };
  const [clicks, total] = await Promise.all([
    db.affiliate_clicks.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.affiliate_clicks.count({ where }),
  ]);

  return {
    data: clicks.map((c) => ({
      id: c.id,
      code: c.code,
      userAgent: c.user_agent,
      ip: c.ip,
      country: c.country,
      region: c.region,
      city: c.city,
      createdAt: c.created_at?.toISOString() ?? null,
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getCreatorCodeUsages(
  userId: string,
  page: number = 1,
  perPage: number = 20
): Promise<PaginatedResult<{
  id: string;
  referredUserId: string;
  referredUsername: string | null;
  usageType: string;
  depositAmountUsd: number;
  wagerAmountUsd: number;
  referrerCutUsd: number;
  userBonusUsd: number;
  createdAt: string;
}>> {
  const where = { affiliate_user_id: userId };
  const [usages, total] = await Promise.all([
    db.affiliate_code_usages.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user_affiliate_code_usages_referred_user_idTouser: {
          select: { username: true, email: true },
        },
      },
    }),
    db.affiliate_code_usages.count({ where }),
  ]);

  return {
    data: usages.map((u) => ({
      id: u.id,
      referredUserId: u.referred_user_id,
      referredUsername:
        u.user_affiliate_code_usages_referred_user_idTouser?.username ??
        u.user_affiliate_code_usages_referred_user_idTouser?.email ??
        null,
      usageType: u.usage_type,
      depositAmountUsd: toNumber(u.deposit_amount_usd),
      wagerAmountUsd: toNumber(u.wager_amount_usd),
      referrerCutUsd: toNumber(u.referrer_cut_usd),
      userBonusUsd: toNumber(u.user_bonus_usd),
      createdAt: u.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getCreatorWithdrawalLimits(userId: string) {
  const limits = await db.creator_withdrawal_limits.findUnique({
    where: { user_id: userId },
  });
  if (!limits) return null;
  return {
    currencyLimitAmount: limits.currency_limit_amount ? toNumber(limits.currency_limit_amount) : null,
    currencyLimitStartDate: limits.currency_limit_start_date?.toISOString() ?? null,
    currencyLimitResetDays: limits.currency_limit_reset_days,
    percentageLimit: limits.percentage_limit ? toNumber(limits.percentage_limit) : null,
  };
}
