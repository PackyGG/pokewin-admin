import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";

export type BotListItem = {
  id: string;
  username: string;
  imageUrl: string | null;
  totalWageredUsd: number;
  totalWonUsd: number;
  totalLostUsd: number;
  battlesPlayed: number;
  battlesWon: number;
  isActive: boolean;
  createdAt: string;
};

export async function getBots(params: {
  page?: number;
  perPage?: number;
  search?: string;
}): Promise<PaginatedResult<BotListItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20, search } = params;

  const where: Record<string, unknown> = {};
  if (search) {
    where.username = { contains: search, mode: "insensitive" };
  }

  const [bots, total] = await Promise.all([
    db.bots.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.bots.count({ where }),
  ]);

  return {
    data: bots.map((b) => ({
      id: b.id,
      username: b.username,
      imageUrl: b.image_url,
      totalWageredUsd: toNumber(b.total_wagered_usd),
      totalWonUsd: toNumber(b.total_won_usd),
      totalLostUsd: toNumber(b.total_lost_usd),
      battlesPlayed: b.battles_played,
      battlesWon: b.battles_won,
      isActive: b.is_active,
      createdAt: b.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
