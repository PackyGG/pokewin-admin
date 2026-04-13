import { db } from "@/lib/db";
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
      include: {
        _count: { select: { promo_code_redemptions: true } },
      },
    }),
    db.promo_codes.count({ where }),
  ]);

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
        maxUses: c.max_uses,
        redemptionCount: c._count.promo_code_redemptions,
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
