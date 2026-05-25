import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";

export type RacePrizeTier = {
  id: string;
  raceType: string;
  position: number;
  prizeAmountUsd: number;
};

export type RacePeriod = {
  id: string;
  raceType: string;
  startsAt: string;
  endsAt: string;
  autoRenew: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
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
  const db = await getDb();
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
  const db = await getDb();
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
  const db = await getDb();
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

/**
 * Active period for each race type and the most recently ended one as a
 * compact history. Used by the Periods tab on /rewards/leaderboards so admins
 * can see at a glance which races are running, when they end, and whether
 * auto-renew is on. Monthly typically has no active row until an admin
 * manually starts one.
 */
export async function getRacePeriodsOverview(params?: {
  recentLimit?: number;
}): Promise<{ active: RacePeriod[]; recent: RacePeriod[] }> {
  const db = await getDb();
  const recentLimit = params?.recentLimit ?? 20;

  const [active, recent] = await Promise.all([
    db.race_periods.findMany({
      where: { status: "active" },
      orderBy: [{ race_type: "asc" }],
    }),
    db.race_periods.findMany({
      where: { status: "ended" },
      orderBy: { ends_at: "desc" },
      take: recentLimit,
    }),
  ]);

  const map = (p: (typeof active)[number]): RacePeriod => ({
    id: p.id,
    raceType: p.race_type,
    startsAt: p.starts_at.toISOString(),
    endsAt: p.ends_at.toISOString(),
    autoRenew: p.auto_renew,
    status: p.status,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  });

  return {
    active: active.map(map),
    recent: recent.map(map),
  };
}

async function getAllTimeLeaderboard(params: {
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<RaceLeaderboardEntry>> {
  const db = await getDb();
  const { search, page = 1, perPage = 20 } = params;
  const offset = (page - 1) * perPage;

  const searchFilter = search ? `%${search}%` : null;

  const [rows, countResult] = await Promise.all([
    db.$queryRaw<
      { user_id: string; username: string | null; total_wagered: number }[]
    >`
      -- All-time wagered MUST come from balances.total_wagered (the user's
      -- true lifetime figure, same source the user-detail page shows), NOT
      -- from SUM(race_leaderboard_snapshots.wagered_usd). Snapshots are one
      -- row per (user, race_type, period), and daily/weekly/monthly periods
      -- OVERLAP — the same wager is recorded in each race type — so summing
      -- across them multiplied the total (e.g. 2x). Membership is still the
      -- set of race participants (distinct snapshot users).
      SELECT
        s.user_id,
        u.username,
        COALESCE(b.total_wagered, 0)::float AS total_wagered
      FROM (SELECT DISTINCT user_id FROM race_leaderboard_snapshots) s
      LEFT JOIN "user" u ON u.id = s.user_id
      LEFT JOIN balances b ON b.user_id = s.user_id
      WHERE (${searchFilter}::text IS NULL OR u.username ILIKE ${searchFilter} OR u.email ILIKE ${searchFilter} OR s.user_id = ${search ?? ""})
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
