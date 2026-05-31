import { unstable_cache } from "next/cache";
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

// ─── Global KPI stats for the /bots page hero strip ───────────────────
//
// Counts that describe the WHOLE bots fleet, independent of the current
// page / search filter. The headline tiles read off this so they stay
// stable as admins paginate or refine the table. Mirrors the
// `getUsersListStats` pattern used on /users.
//
// One round-trip — Postgres folds the COUNT(*) FILTER + SUM aggregates
// into a single sequential scan with predicate filters. Cached
// cross-request (60s) so spamming search doesn't fan the same scan
// into the DB on every keystroke.

export type BotsListStats = {
  totalBots: number;
  activeBots: number;
  totalWageredUsd: number;
  totalBattles: number;
};

const cachedBotsListStats = unstable_cache(
  async (): Promise<BotsListStats> => {
    const db = await getDb();
    const rows = await db.$queryRaw<
      { total: string; active: string; wagered: string; battles: string }[]
    >`
      SELECT
        COUNT(*)::text                                                           AS total,
        COUNT(*) FILTER (WHERE is_active = true)::text                            AS active,
        COALESCE(SUM(total_wagered_usd::numeric), 0)::text                        AS wagered,
        COALESCE(SUM(battles_played), 0)::text                                    AS battles
      FROM bots
    `;
    const r = rows[0];
    return {
      totalBots: Number(r?.total ?? 0),
      activeBots: Number(r?.active ?? 0),
      totalWageredUsd: Number(r?.wagered ?? 0),
      totalBattles: Number(r?.battles ?? 0),
    };
  },
  ["bots-list-stats-v1"],
  { revalidate: 60, tags: ["bots-list-stats"] },
);

export async function getBotsListStats(): Promise<BotsListStats> {
  return cachedBotsListStats();
}
