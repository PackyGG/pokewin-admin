import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { excludeStaffAndBlacklisted } from "./_blacklist";
import type { PaginatedResult } from "@/lib/types";

export type RakebackConfigItem = {
  id: string;
  type: string;
  percentage: number;
  expirationDays: number;
  displayName: string;
  enabled: boolean;
};

export type RakebackClaimItem = {
  id: string;
  userId: string;
  username: string | null;
  rakebackType: string;
  periodStart: string;
  wageredAmountUsd: number;
  rakebackAmountUsd: number;
  claimedAt: string | null;
  createdAt: string;
};

export type RakebackStats = {
  totalClaimed: number;
  totalPending: number;
  claimCount: number;
  byType: {
    type: string;
    totalAmount: number;
    claimCount: number;
  }[];
};

export async function getRakebackConfigs(): Promise<RakebackConfigItem[]> {
  const db = await getDb();
  const configs = await db.rakeback_config.findMany({
    orderBy: { type: "asc" },
  });

  return configs.map((r) => ({
    id: r.id,
    type: r.type,
    percentage: toNumber(r.percentage),
    expirationDays: r.expiration_days,
    displayName: r.display_name,
    enabled: r.enabled,
  }));
}

export async function getRakebackClaims(params: {
  page?: number;
  perPage?: number;
  type?: string;
  search?: string;
}): Promise<PaginatedResult<RakebackClaimItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20, type, search } = params;

  const where: Record<string, unknown> = {};
  if (type && type !== "all") {
    where.rakeback_type = type;
  }
  if (search) {
    where.user = { username: { contains: search, mode: "insensitive" } };
  }

  const [claims, total] = await Promise.all([
    db.rakeback_claims.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user: { select: { username: true } },
      },
    }),
    db.rakeback_claims.count({ where }),
  ]);

  return {
    data: claims.map((c) => ({
      id: c.id,
      userId: c.user_id,
      username: c.user?.username ?? null,
      rakebackType: c.rakeback_type,
      periodStart: c.period_start.toISOString(),
      wageredAmountUsd: toNumber(c.wagered_amount_usd),
      rakebackAmountUsd: toNumber(c.rakeback_amount_usd),
      claimedAt: c.claimed_at?.toISOString() ?? null,
      createdAt: c.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export type RewardPack = {
  id: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number;
};

export type RewardItem = {
  id: string;
  slug: string;
  name: string;
  type: string;
  levelRequired: number;
  cashAmount: number | null;
  packIds: string[];
  packs: RewardPack[];
  packCount: number;
  createdAt: string;
};

export async function getRewards(params: {
  page?: number;
  perPage?: number;
  search?: string;
  type?: string;
  minCashAmount?: number;
  maxCashAmount?: number;
}): Promise<PaginatedResult<RewardItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20, search, type, minCashAmount, maxCashAmount } = params;

  const where: Record<string, unknown> = {};
  if (type && type !== "all") {
    where.type = type;
  }
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { slug: { contains: search, mode: "insensitive" } },
    ];
  }
  if (minCashAmount != null || maxCashAmount != null) {
    const cashFilter: Record<string, number> = {};
    if (minCashAmount != null) cashFilter.gte = minCashAmount;
    if (maxCashAmount != null) cashFilter.lte = maxCashAmount;
    where.cash_amount = cashFilter;
  }

  const [rewards, total] = await Promise.all([
    db.rewards.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.rewards.count({ where }),
  ]);

  // Fetch pack details for all rewards in one query
  const allPackIds = [...new Set(rewards.flatMap((r) => r.pack_ids))];
  const packsMap = new Map<string, RewardPack>();
  if (allPackIds.length > 0) {
    const packs = await db.packs.findMany({
      where: { id: { in: allPackIds } },
      select: { id: true, name: true, image_url: true, price: true },
    });
    for (const p of packs) {
      packsMap.set(p.id, { id: p.id, name: p.name, imageUrl: p.image_url, priceUsd: toNumber(p.price) });
    }
  }

  return {
    data: rewards.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      type: r.type,
      levelRequired: r.level_required,
      cashAmount: r.cash_amount ? toNumber(r.cash_amount) : null,
      packIds: r.pack_ids,
      packs: r.pack_ids
        .map((id) => packsMap.get(id))
        .filter((p): p is RewardPack => p != null),
      packCount: r.pack_ids.length,
      createdAt: r.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getLevelUpRewards(params: {
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<RewardItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20 } = params;

  const where = {
    level_required: { gt: 0 },
  };

  const [rewards, total] = await Promise.all([
    db.rewards.findMany({
      where,
      orderBy: { level_required: "asc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.rewards.count({ where }),
  ]);

  const allPackIds = [...new Set(rewards.flatMap((r) => r.pack_ids))];
  const packsMap = new Map<string, RewardPack>();
  if (allPackIds.length > 0) {
    const packs = await db.packs.findMany({
      where: { id: { in: allPackIds } },
      select: { id: true, name: true, image_url: true, price: true },
    });
    for (const p of packs) {
      packsMap.set(p.id, { id: p.id, name: p.name, imageUrl: p.image_url, priceUsd: toNumber(p.price) });
    }
  }

  return {
    data: rewards.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      type: r.type,
      levelRequired: r.level_required,
      cashAmount: r.cash_amount ? toNumber(r.cash_amount) : null,
      packIds: r.pack_ids,
      packs: r.pack_ids
        .map((id) => packsMap.get(id))
        .filter((p): p is RewardPack => p != null),
      packCount: r.pack_ids.length,
      createdAt: r.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getRakebackStats(): Promise<RakebackStats> {
  const db = await getDb();
  const userScope = await excludeStaffAndBlacklisted();
  // Previously this pulled every rakeback_claims row and aggregated in JS —
  // that scales linearly with claim count. Push the aggregation to Postgres
  // and fetch only the two summaries we actually need.
  const [claimedSum, pendingSum, byTypeRows] = await Promise.all([
    db.rakeback_claims.aggregate({
      where: { claimed_at: { not: null }, user: userScope },
      _sum: { rakeback_amount_usd: true },
      _count: { _all: true },
    }),
    db.rakeback_claims.aggregate({
      where: { claimed_at: null, user: userScope },
      _sum: { rakeback_amount_usd: true },
      _count: { _all: true },
    }),
    db.rakeback_claims.groupBy({
      by: ["rakeback_type"],
      where: { user: userScope },
      _sum: { rakeback_amount_usd: true },
      _count: { _all: true },
    }),
  ]);

  return {
    totalClaimed: toNumber(claimedSum._sum.rakeback_amount_usd),
    totalPending: toNumber(pendingSum._sum.rakeback_amount_usd),
    claimCount: claimedSum._count._all + pendingSum._count._all,
    byType: byTypeRows.map((r) => ({
      type: r.rakeback_type,
      totalAmount: toNumber(r._sum.rakeback_amount_usd),
      claimCount: r._count._all,
    })),
  };
}
