import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import type { race_type } from "@/generated/prisma/enums";
import { getRewardExpiry } from "@/lib/backend-api/reward-expiry";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  computeRaceClaimWindow,
  type RaceClaimWindow,
} from "@/lib/reward-expiry/race-claim-window";

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
  // Global claim kill-switch. Only meaningful for ended periods: while
  // claimsFrozen is true no winner can claim. unfrozenAt/By record who
  // opened claims (lifted the freeze) and when.
  claimsFrozen: boolean;
  claimsUnfrozenAt: string | null;
  claimsUnfrozenBy: string | null;
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

export type RaceClaimHoldInfo = {
  id: string;
  reason: string;
  createdBy: string;
  createdAt: string;
};

export type RaceLeaderboardEntry = {
  id: string;
  userId: string;
  username: string | null;
  position: number;
  wageredUsd: number;
  /** Projected prize from race_prize_tiers; null when no tier for this position. */
  prizeAmountUsd: number | null;
  // Per-user claim review state for the selected period. `hold` is the active
  // (un-released) hold blocking this user's claim, if any. `claimedAt` is set
  // once the prize has been paid out — a claimed prize can no longer be frozen.
  // Both are null in the all-time ("all") view, which has no single period.
  hold: RaceClaimHoldInfo | null;
  claimedAt: string | null;
  /**
   * True when the user is on the admin excluded-users blacklist. The
   * standings deliberately still INCLUDE them (so this view mirrors the
   * real, user-facing leaderboard on packy.gg) and just flag them so an
   * operator can tell they're excluded from analytics aggregates. Mirrors
   * the same flag on the affiliate leaderboards (creators-leaderboards.ts).
   */
  excluded: boolean;
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

export type RaceLeaderboardPeriod = {
  periodStart: string;
  participants: number;
};

/**
 * The actual leaderboards that exist for a race type, taken straight from
 * race_leaderboard_snapshots (one group per period_start). This is what the
 * Standings period selector is populated from — instead of guessing a calendar
 * date that may not line up with any real period (monthly races run on custom
 * cadences, so a "1st of the month" guess shows nothing). Most-recent first.
 */
export async function getRaceLeaderboardPeriods(params: {
  raceType: string;
  limit?: number;
}): Promise<RaceLeaderboardPeriod[]> {
  const db = await getDb();
  const { raceType, limit = 120 } = params;

  // All-time has no single period — nothing to select.
  if (!raceType || raceType === "all") return [];

  const groups = await db.race_leaderboard_snapshots.groupBy({
    by: ["period_start"],
    where: { race_type: raceType as race_type },
    _count: { _all: true },
    orderBy: { period_start: "desc" },
    take: limit,
  });

  return groups.map((g) => ({
    periodStart: g.period_start.toISOString().slice(0, 10),
    participants: g._count._all,
  }));
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

  // `position` on race_leaderboard_snapshots is only finalized once a period
  // ends — a backend job assigns 1..N (by wagered_usd desc) at that point.
  // While the period is still running every row's position stays 0 (verified
  // read-only against prod: the active weekly period starting 2026-07-06 had
  // all 371 rows at position 0, while the prior ended period was correctly
  // 1..N and matched ORDER BY wagered_usd DESC exactly through the
  // prize-tier range). Sorting by the raw column then shows every row as
  // "#0" in an arbitrary order. Detect that case and rank live by
  // wagered_usd instead of trusting the unset column.
  const maxPosition = await db.race_leaderboard_snapshots.aggregate({
    where,
    _max: { position: true },
  });
  const unfinalized = (maxPosition._max.position ?? 0) === 0;

  // Excluded-users blacklist — used only to FLAG rows, never to drop them.
  // Mirrors the affiliate leaderboards: a blacklisted user who's actually #1
  // still has to show as #1 here. Fail-soft to no flags.
  const excludedSet = new Set(
    await getExcludedUserIds().catch(() => [] as string[]),
  );

  const [entries, total, tiers] = await Promise.all([
    db.race_leaderboard_snapshots.findMany({
      where,
      orderBy: unfinalized
        ? [{ wagered_usd: "desc" }, { user_id: "asc" }]
        : [{ position: "asc" }],
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user: { select: { username: true } },
      },
    }),
    db.race_leaderboard_snapshots.count({ where }),
    db.race_prize_tiers.findMany({
      where: { race_type: raceType as race_type },
      select: { position: true, prize_amount_usd: true },
    }),
  ]);

  const tierByPosition = new Map(
    tiers.map((t) => [t.position, toNumber(t.prize_amount_usd)] as const),
  );

  // Overlay per-user claim review state (active holds + paid claims) for the
  // selected period so the leaderboard doubles as the fraud-review surface.
  // Only the rows on this page are looked up — one round-trip each.
  const userIds = entries.map((e) => e.user_id);
  const periodDate = periodStart ? new Date(periodStart) : null;
  const holdByUser = new Map<string, RaceClaimHoldInfo>();
  const claimedAtByUser = new Map<string, string>();
  if (periodDate && userIds.length > 0) {
    const [holds, claims] = await Promise.all([
      db.race_claim_holds.findMany({
        where: {
          race_type: raceType as race_type,
          race_period_start: periodDate,
          released_at: null,
          user_id: { in: userIds },
        },
      }),
      db.race_claims.findMany({
        where: {
          race_type: raceType as race_type,
          race_period_start: periodDate,
          user_id: { in: userIds },
        },
        select: { user_id: true, claimed_at: true },
      }),
    ]);
    for (const h of holds) {
      holdByUser.set(h.user_id, {
        id: h.id,
        reason: h.reason,
        createdBy: h.created_by,
        createdAt: h.created_at.toISOString(),
      });
    }
    for (const c of claims) {
      claimedAtByUser.set(c.user_id, c.claimed_at.toISOString());
    }
  }

  return {
    data: entries.map((e, i) => {
      const rank = unfinalized ? (page - 1) * perPage + i + 1 : e.position;
      return {
        id: e.id,
        userId: e.user_id,
        username: e.user?.username ?? null,
        position: rank,
        wageredUsd: toNumber(e.wagered_usd),
        prizeAmountUsd: tierByPosition.get(rank) ?? null,
        hold: holdByUser.get(e.user_id) ?? null,
        claimedAt: claimedAtByUser.get(e.user_id) ?? null,
        excluded: excludedSet.has(e.user_id),
      };
    }),
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
    claimsFrozen: p.claims_frozen,
    claimsUnfrozenAt: p.claims_unfrozen_at?.toISOString() ?? null,
    claimsUnfrozenBy: p.claims_unfrozen_by,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  });

  return {
    active: active.map(map),
    recent: recent.map(map),
  };
}

/**
 * Claim-window context for a standings period — period end from snapshots or
 * race_periods, plus live race_days from the reward-expiry API.
 */
export async function getRaceStandingsClaimWindow(params: {
  raceType: string;
  periodStart: string;
}): Promise<RaceClaimWindow> {
  const { raceType, periodStart } = params;
  const db = await getDb();
  const periodStartDate = new Date(`${periodStart}T00:00:00.000Z`);
  const nextDay = new Date(periodStartDate.getTime() + 86_400_000);

  const [snapshot, racePeriod, expiryResult] = await Promise.all([
    db.race_leaderboard_snapshots.findFirst({
      where: {
        race_type: raceType as race_type,
        period_start: periodStartDate,
      },
      select: { period_end: true },
      orderBy: { period_end: "desc" },
    }),
    db.race_periods.findFirst({
      where: {
        race_type: raceType as race_type,
        starts_at: { gte: periodStartDate, lt: nextDay },
      },
      orderBy: { created_at: "desc" },
      select: {
        ends_at: true,
        status: true,
        claims_frozen: true,
      },
    }),
    getRewardExpiry().then(
      (e) => e.race_days as number,
      () => null as number | null,
    ),
  ]);

  const periodEnd =
    snapshot?.period_end ??
    (racePeriod?.status === "ended" || racePeriod?.status === "active"
      ? racePeriod.ends_at
      : null);

  return computeRaceClaimWindow({
    periodEndIso: periodEnd?.toISOString() ?? null,
    raceExpiryDays: expiryResult,
    claimsFrozen: racePeriod?.claims_frozen ?? false,
  });
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

  const excludedSet = new Set(
    await getExcludedUserIds().catch(() => [] as string[]),
  );

  return {
    data: rows.map((r, i) => ({
      id: r.user_id,
      userId: r.user_id,
      username: r.username,
      position: offset + i + 1,
      wageredUsd: r.total_wagered,
      prizeAmountUsd: null,
      // All-time view spans every period, so per-period claim review state
      // (holds/claims) doesn't apply.
      hold: null,
      claimedAt: null,
      excluded: excludedSet.has(r.user_id),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
