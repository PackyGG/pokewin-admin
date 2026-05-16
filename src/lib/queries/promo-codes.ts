import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";

export type PromoCodeListItem = {
  id: string;
  code: string | null;
  codeHash: string;
  value: number;
  region: string;
  minimumLevel: number;
  /** Lifetime wager required (USD) before the user can redeem. 0 = no gate. */
  minimumWagerAmount: number;
  /**
   * Window the wager requirement is evaluated over (days). 0 means "all-time
   * lifetime wager"; non-zero means "wager in the last N days".
   */
  wagerPeriodDays: number;
  /** Minimum account age in days before the user can redeem. 0 = no gate. */
  minimumAccountAgeDays: number;
  /** All-time deposit total (USD) the user must reach before redeeming. 0 = no gate. */
  minimumDepositAmount: number;
  /** If set, the user must have signed up with this exact affiliate code (case-insensitive). */
  requiredAffiliateCode: string | null;
  /** Whether the user must have a linked Discord account to redeem. */
  requiresDiscord: boolean;
  maxUses: number;
  redemptionCount: number;
  expiresAt: string | null;
  createdAt: string;
};

export async function getPromoCodes(params: {
  page?: number;
  perPage?: number;
  region?: string;
  status?: string;
}): Promise<PaginatedResult<PromoCodeListItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20, region, status } = params;

  const where: Prisma.promo_codesWhereInput = {};

  if (region && region !== "all") {
    where.region = region as Prisma.Enumgift_card_regionFieldUpdateOperationsInput["set"];
  }

  if (status === "active") {
    where.OR = [
      { expires_at: null },
      { expires_at: { gt: new Date() } },
    ];
  } else if (status === "expired") {
    where.expires_at = { lte: new Date() };
  }

  const [codes, total] = await Promise.all([
    db.promo_codes.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.promo_codes.count({ where }),
  ]);

  // Replace the per-row `_count` subquery (which Prisma compiles to a
  // correlated subselect on every promo_code row) with one scoped groupBy
  // on the visible page. One round-trip, one aggregate scan over the
  // page's promo_code ids.
  const visibleCodeIds = codes.map((c) => c.id);
  const redemptionCounts =
    visibleCodeIds.length > 0
      ? await db.promo_code_redemptions.groupBy({
          by: ["promo_code_id"],
          where: { promo_code_id: { in: visibleCodeIds } },
          _count: { _all: true },
        })
      : [];
  const countByCodeId = new Map(
    redemptionCounts.map((r) => [r.promo_code_id, r._count._all]),
  );

  return {
    data: codes.map((c) => {
      const meta = c.metadata as Record<string, unknown> | null;
      return {
        id: c.id,
        code: (meta?.code as string) ?? null,
        codeHash: c.code_hash,
        value: toNumber(c.value),
        region: c.region,
        minimumLevel: c.minimum_level,
        minimumWagerAmount: toNumber(c.minimum_wager_amount),
        wagerPeriodDays: c.wager_period_days,
        minimumAccountAgeDays: c.minimum_account_age_days,
        maximumAccountAgeHours: c.maximum_account_age_hours,
        minimumDepositAmount: toNumber(c.minimum_deposit_amount),
        requiredAffiliateCode: c.required_affiliate_code,
        requiresDiscord: c.requires_discord,
        maxUses: c.max_uses,
        redemptionCount: countByCodeId.get(c.id) ?? 0,
        expiresAt: c.expires_at?.toISOString() ?? null,
        createdAt: c.created_at.toISOString(),
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getPromoCodeDetail(id: string) {
  const db = await getDb();
  const code = await db.promo_codes.findUnique({
    where: { id },
    include: {
      promo_code_redemptions: {
        include: {
          user: { select: { username: true, email: true } },
        },
        orderBy: { redeemed_at: "desc" },
        take: 100,
      },
    },
  });

  if (!code) return null;

  const meta = code.metadata as Record<string, unknown> | null;
  return {
    id: code.id,
    code: (meta?.code as string) ?? null,
    codeHash: code.code_hash,
    value: toNumber(code.value),
    region: code.region,
    minimumLevel: code.minimum_level,
    minimumWagerAmount: toNumber(code.minimum_wager_amount),
    wagerPeriodDays: code.wager_period_days,
    minimumAccountAgeDays: code.minimum_account_age_days,
    maximumAccountAgeHours: code.maximum_account_age_hours,
    minimumDepositAmount: toNumber(code.minimum_deposit_amount),
    requiredAffiliateCode: code.required_affiliate_code,
    requiresDiscord: code.requires_discord,
    maxUses: code.max_uses,
    expiresAt: code.expires_at?.toISOString() ?? null,
    metadata: code.metadata,
    createdAt: code.created_at.toISOString(),
    redemptions: code.promo_code_redemptions.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.user?.username ?? null,
      email: r.user?.email ?? null,
      ipAddress: r.ip_address,
      redeemedAt: r.redeemed_at.toISOString(),
    })),
  };
}
