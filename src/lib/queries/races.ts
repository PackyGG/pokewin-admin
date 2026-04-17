import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";

export type RacePrizeTier = {
  id: string;
  raceType: string;
  position: number;
  prizeAmountUsd: number;
};

export type RaceClaimItem = {
  id: string;
  userId: string;
  username: string | null;
  raceType: string;
  racePeriodStart: string;
  position: number;
  prizeAmountUsd: number;
  claimedAt: string;
};

export type RaceLeaderboardEntry = {
  id: string;
  userId: string;
  username: string | null;
  position: number;
  wageredUsd: number;
};

export async function getRacePrizeTiers() {
  const tiers = await db.race_prize_tiers.findMany({
    orderBy: [{ race_type: "asc" }, { position: "asc" }],
  });

  return tiers.map((r) => ({
    id: r.id,
    raceType: r.race_type,
    position: r.position,
    prizeAmountUsd: toNumber(r.prize_amount_usd),
  }));
}

export async function getRaceClaims(params: {
  page?: number;
  perPage?: number;
  raceType?: string;
}): Promise<PaginatedResult<RaceClaimItem>> {
  const { page = 1, perPage = 20, raceType } = params;

  const where: Record<string, unknown> = {};
  if (raceType && raceType !== "all") {
    where.race_type = raceType;
  }

  const [claims, total] = await Promise.all([
    db.race_claims.findMany({
      where,
      orderBy: { claimed_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user: { select: { username: true } },
      },
    }),
    db.race_claims.count({ where }),
  ]);

  return {
    data: claims.map((c) => ({
      id: c.id,
      userId: c.user_id,
      username: c.user?.username ?? null,
      raceType: c.race_type,
      racePeriodStart: c.race_period_start.toISOString(),
      position: c.position,
      prizeAmountUsd: toNumber(c.prize_amount_usd),
      claimedAt: c.claimed_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getRaceLeaderboard(params: {
  raceType?: string;
  periodStart?: string;
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<RaceLeaderboardEntry>> {
  const { raceType = "daily", periodStart, search, page = 1, perPage = 20 } = params;

  if (raceType === "all") {
    return getAllTimeLeaderboard({ search, page, perPage });
  }

  const where: Record<string, unknown> = {
    race_type: raceType,
  };
  if (periodStart) {
    where.period_start = new Date(periodStart);
  }
  if (search) {
    where.user = {
      OR: [
        { username: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { id: search },
      ],
    };
  }

  const [entries, total] = await Promise.all([
    db.race_leaderboard_snapshots.findMany({
      where,
      orderBy: { position: "asc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user: { select: { username: true } },
      },
    }),
    db.race_leaderboard_snapshots.count({ where }),
  ]);

  return {
    data: entries.map((e) => ({
      id: e.id,
      userId: e.user_id,
      username: e.user?.username ?? null,
      position: e.position,
      wageredUsd: toNumber(e.wagered_usd),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

async function getAllTimeLeaderboard(params: {
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<RaceLeaderboardEntry>> {
  const { search, page = 1, perPage = 20 } = params;
  const offset = (page - 1) * perPage;

  const searchFilter = search ? `%${search}%` : null;

  const [rows, countResult] = await Promise.all([
    db.$queryRaw<
      { user_id: string; username: string | null; total_wagered: number }[]
    >`
      SELECT
        s.user_id,
        u.username,
        SUM(s.wagered_usd)::float AS total_wagered
      FROM race_leaderboard_snapshots s
      LEFT JOIN "user" u ON u.id = s.user_id
      WHERE (${searchFilter}::text IS NULL OR u.username ILIKE ${searchFilter} OR u.email ILIKE ${searchFilter} OR s.user_id = ${search ?? ""})
      GROUP BY s.user_id, u.username
      ORDER BY total_wagered DESC
      LIMIT ${perPage} OFFSET ${offset}
    `,
    db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT s.user_id) AS count
      FROM race_leaderboard_snapshots s
      LEFT JOIN "user" u ON u.id = s.user_id
      WHERE (${searchFilter}::text IS NULL OR u.username ILIKE ${searchFilter} OR u.email ILIKE ${searchFilter} OR s.user_id = ${search ?? ""})
    `,
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    data: rows.map((r, i) => ({
      id: r.user_id,
      userId: r.user_id,
      username: r.username,
      position: offset + i + 1,
      wageredUsd: r.total_wagered,
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
