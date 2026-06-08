import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  excludeStaffAndBlacklisted,
  excludeStaffAndBlacklistedSqlFromIds,
} from "@/lib/queries/_blacklist";

/**
 * Platform leaderboards summary for /rewards/analytics.
 *
 * Surfaces the site-wide daily + weekly cash races run by the platform
 * (`race_periods` / `race_prize_tiers` / `race_claims` /
 * `race_leaderboard_snapshots`). These are the platform's OWN
 * leaderboards — NOT the per-creator affiliate leaderboards
 * (`affiliate_leaderboards`), which live on /creators/leaderboards.
 *
 * For each race type (daily, weekly) we expose:
 *   - The current active period if one is running, otherwise the most
 *     recently ended period — labelled accordingly so the page can show
 *     "Current daily race" vs. "Last daily race".
 *   - The static prize pool (sum of `race_prize_tiers.prize_amount_usd`
 *     for that race_type — the budgeted spend per period).
 *   - Top 5 winners. When the period is ended, that's the top 5 by
 *     `race_claims.prize_amount_usd` for the period. When the period is
 *     still active, claims aren't filed yet, so we project who *would*
 *     win by reading the top 5 `race_leaderboard_snapshots` rows for the
 *     period and pairing them with the corresponding prize tier amount.
 *
 * Lifetime prize-payout total (`SUM(race_claims.prize_amount_usd)`) is
 * also returned for the KPI strip on /rewards/analytics. Every amount
 * here is money flowing OUT to users → house cost → rose in the UI per
 * CLAUDE.md's House-POV rule.
 *
 * Staff + excluded-users blacklist are dropped from every aggregate and
 * winner list on this surface.
 */

export type RaceLeaderboardKind = "daily" | "weekly";

export type RaceLeaderboardWinnerRow = {
  position: number;
  userId: string;
  username: string | null;
  /** Prize awarded (or projected) for this position. */
  prizeAmountUsd: number;
  /** Wagered total for this user in the period (drives ranking). */
  wageredUsd: number;
};

export type RaceLeaderboardSummary = {
  kind: RaceLeaderboardKind;
  /** "active" when the period is currently running, "ended" when it's the most recent completed one. */
  state: "active" | "ended" | "none";
  periodStart: string | null;
  periodEnd: string | null;
  /** Total prize pool from `race_prize_tiers` for this race_type. */
  prizePool: number;
  /** Number of tiered prize positions (e.g. top 10). */
  prizePositions: number;
  /** Top 5 winners / projected winners. */
  topWinners: RaceLeaderboardWinnerRow[];
};

export type RewardsLeaderboardsData = {
  daily: RaceLeaderboardSummary;
  weekly: RaceLeaderboardSummary;
  /** Lifetime sum of `race_claims.prize_amount_usd` across all race types. */
  lifetimePrizesPaid: number;
  /** Lifetime number of prize claims. */
  lifetimeClaimsCount: number;
};

const TOP_WINNERS_LIMIT = 5;

async function raceClaimsUserScopeSql(): Promise<string> {
  const excluded = await getExcludedUserIds();
  return excludeStaffAndBlacklistedSqlFromIds(excluded);
}

/**
 * Build the leaderboard summary for a single race type (daily or weekly).
 */
async function buildRaceSummary(
  kind: RaceLeaderboardKind,
): Promise<RaceLeaderboardSummary> {
  const db = await getDb();
  const userScopeSql = await raceClaimsUserScopeSql();
  const userRelation = await excludeStaffAndBlacklisted();

  const [tiers, activePeriod, recentEndedPeriod] = await Promise.all([
    db.race_prize_tiers.findMany({
      where: { race_type: kind },
      orderBy: { position: "asc" },
    }),
    db.race_periods.findFirst({
      where: { race_type: kind, status: "active" },
      orderBy: { starts_at: "desc" },
    }),
    db.race_periods.findFirst({
      where: { race_type: kind, status: "ended" },
      orderBy: { ends_at: "desc" },
    }),
  ]);

  const prizePool = tiers.reduce((a, t) => a + toNumber(t.prize_amount_usd), 0);
  const prizePositions = tiers.length;
  const tierByPosition = new Map(
    tiers.map((t) => [t.position, toNumber(t.prize_amount_usd)] as const),
  );

  const chosen = activePeriod ?? recentEndedPeriod;
  if (!chosen) {
    return {
      kind,
      state: "none",
      periodStart: null,
      periodEnd: null,
      prizePool,
      prizePositions,
      topWinners: [],
    };
  }

  const state: "active" | "ended" = activePeriod ? "active" : "ended";
  const periodStartDateString = chosen.starts_at.toISOString().slice(0, 10);

  let topWinners: RaceLeaderboardWinnerRow[] = [];

  if (state === "ended") {
    const rows = await db.$queryRawUnsafe<
      {
        user_id: string;
        username: string | null;
        position: number;
        prize_amount_usd: string;
        wagered_usd: string | null;
      }[]
    >(`
      SELECT
        rc.user_id,
        u.username,
        rc.position,
        rc.prize_amount_usd::text AS prize_amount_usd,
        rls.wagered_usd::text AS wagered_usd
      FROM race_claims rc
      LEFT JOIN "user" u ON u.id = rc.user_id
      LEFT JOIN race_leaderboard_snapshots rls
        ON rls.user_id = rc.user_id
       AND rls.race_type = rc.race_type
       AND rls.period_start = rc.race_period_start
      WHERE rc.race_type = '${kind}'::race_type
        AND rc.race_period_start = '${periodStartDateString}'::date
        AND rc.${userScopeSql}
      ORDER BY rc.position ASC
      LIMIT ${TOP_WINNERS_LIMIT}
    `);
    topWinners = rows.map((r) => ({
      position: r.position,
      userId: r.user_id,
      username: r.username,
      prizeAmountUsd: toNumber(r.prize_amount_usd),
      wageredUsd: r.wagered_usd ? toNumber(r.wagered_usd) : 0,
    }));
  } else {
    const snapshots = await db.race_leaderboard_snapshots.findMany({
      where: {
        race_type: kind,
        period_start: new Date(periodStartDateString),
        user: userRelation,
      },
      orderBy: { position: "asc" },
      take: TOP_WINNERS_LIMIT,
      include: { user: { select: { username: true } } },
    });
    topWinners = snapshots.map((s) => ({
      position: s.position,
      userId: s.user_id,
      username: s.user?.username ?? null,
      prizeAmountUsd: tierByPosition.get(s.position) ?? 0,
      wageredUsd: toNumber(s.wagered_usd),
    }));
  }

  return {
    kind,
    state,
    periodStart: chosen.starts_at.toISOString(),
    periodEnd: chosen.ends_at.toISOString(),
    prizePool,
    prizePositions,
    topWinners,
  };
}

export type LifetimePrizesByRaceType = {
  raceType: string;
  total: number;
  claims: number;
};

export type LifetimePrizesTopWinner = {
  userId: string;
  username: string | null;
  total: number;
  claims: number;
};

export type LifetimePrizesBreakdown = {
  /** Per-race-type rows. Same total as the headline KPI by construction. */
  byRaceType: LifetimePrizesByRaceType[];
  /** Total lifetime prize money across every race type. */
  total: number;
  /** Total lifetime claim count across every race type. */
  claims: number;
};

/**
 * Per-race-type breakdown of the lifetime prizes-paid KPI on
 * /rewards/analytics.
 */
export async function getLifetimePrizesBreakdown(): Promise<LifetimePrizesBreakdown> {
  const db = await getDb();
  const userScope = await excludeStaffAndBlacklisted();
  const rows = await db.race_claims.groupBy({
    by: ["race_type"],
    where: { user: userScope },
    _sum: { prize_amount_usd: true },
    _count: { _all: true },
  });
  const byRaceType: LifetimePrizesByRaceType[] = rows
    .map((r) => ({
      raceType: r.race_type,
      total: toNumber(r._sum.prize_amount_usd ?? 0),
      claims: r._count._all,
    }))
    .sort((a, b) => b.total - a.total);
  const total = byRaceType.reduce((a, r) => a + r.total, 0);
  const claims = byRaceType.reduce((a, r) => a + r.claims, 0);
  return { byRaceType, total, claims };
}

/**
 * Top lifetime prize winners across every race type.
 */
export async function getLifetimePrizesTopWinners(
  limit = 10,
): Promise<LifetimePrizesTopWinner[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const db = await getDb();
  const userScopeSql = await raceClaimsUserScopeSql();
  const rows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      total: string;
      claims: string;
    }[]
  >(`
    SELECT
      rc.user_id,
      u.username,
      SUM(rc.prize_amount_usd::numeric)::text AS total,
      COUNT(*)::text AS claims
    FROM race_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE rc.${userScopeSql}
    GROUP BY rc.user_id, u.username
    ORDER BY SUM(rc.prize_amount_usd::numeric) DESC
    LIMIT ${safeLimit}
  `);
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    total: toNumber(r.total),
    claims: Number(r.claims),
  }));
}

export type PrizeBudgetTierRow = {
  raceType: string;
  position: number;
  prizeAmountUsd: number;
};

export type PrizeBudgetBreakdown = {
  rows: PrizeBudgetTierRow[];
  total: number;
};

/**
 * Per-tier prize budget breakdown — every tier row from
 * `race_prize_tiers` for the requested race types.
 */
export async function getPrizeBudgetBreakdown(
  raceTypes: string[],
): Promise<PrizeBudgetBreakdown> {
  const db = await getDb();
  const tiers = await db.race_prize_tiers.findMany({
    where: { race_type: { in: raceTypes as RaceLeaderboardKind[] } },
    orderBy: [{ race_type: "asc" }, { position: "asc" }],
  });
  const rows: PrizeBudgetTierRow[] = tiers.map((t) => ({
    raceType: t.race_type,
    position: t.position,
    prizeAmountUsd: toNumber(t.prize_amount_usd),
  }));
  const total = rows.reduce((a, r) => a + r.prizeAmountUsd, 0);
  return { rows, total };
}

export async function getRewardsLeaderboards(): Promise<RewardsLeaderboardsData> {
  const db = await getDb();
  const userScope = await excludeStaffAndBlacklisted();

  const [daily, weekly, lifetimeRow] = await Promise.all([
    buildRaceSummary("daily"),
    buildRaceSummary("weekly"),
    db.race_claims.aggregate({
      where: { user: userScope },
      _sum: { prize_amount_usd: true },
      _count: { _all: true },
    }),
  ]);

  return {
    daily,
    weekly,
    lifetimePrizesPaid: toNumber(lifetimeRow._sum.prize_amount_usd ?? 0),
    lifetimeClaimsCount: lifetimeRow._count._all,
  };
}
