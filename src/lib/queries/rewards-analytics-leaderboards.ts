import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

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

/**
 * Build the leaderboard summary for a single race type (daily or weekly).
 *
 * Implementation notes:
 *   - Prize tiers (`race_prize_tiers`) define the budget per race_type
 *     and are independent of the period — same pool every run.
 *   - For an ENDED period we drive winners from `race_claims` (actually
 *     paid out) joined to `race_leaderboard_snapshots` for the wagered
 *     amount.
 *   - For an ACTIVE period we drive from `race_leaderboard_snapshots`
 *     (top positions by wager) and pair each row with the matching
 *     prize tier amount, since claims haven't been issued yet.
 *   - We deliberately do NOT exclude staff / blacklisted users here —
 *     per `_blacklist.ts` ("race queries keep counting blacklisted users
 *     so leaderboard positions don't shift") leaderboards stay raw.
 */
async function buildRaceSummary(
  kind: RaceLeaderboardKind,
): Promise<RaceLeaderboardSummary> {
  const db = await getDb();

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

  // Prefer the active period as the page's primary slot — that's the
  // race the operator wants to see live. Fall back to the most recently
  // ended one for finished context (and labelling).
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
  // race_leaderboard_snapshots.period_start is a DATE — derive it from
  // the period's starts_at (UTC date) so the join key matches.
  const periodStartDateString = chosen.starts_at.toISOString().slice(0, 10);

  let topWinners: RaceLeaderboardWinnerRow[] = [];

  if (state === "ended") {
    // Pull actual paid claims for this period, top 5 by prize amount.
    // LEFT JOIN snapshots to also surface the wagered total (same
    // (user_id, race_type, period_start) tuple used by the snapshot
    // unique constraint).
    const rows = await db.$queryRaw<
      {
        user_id: string;
        username: string | null;
        position: number;
        prize_amount_usd: string;
        wagered_usd: string | null;
      }[]
    >`
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
      WHERE rc.race_type = ${kind}::race_type
        AND rc.race_period_start = ${periodStartDateString}::date
      ORDER BY rc.position ASC
      LIMIT ${TOP_WINNERS_LIMIT}
    `;
    topWinners = rows.map((r) => ({
      position: r.position,
      userId: r.user_id,
      username: r.username,
      prizeAmountUsd: toNumber(r.prize_amount_usd),
      wageredUsd: r.wagered_usd ? toNumber(r.wagered_usd) : 0,
    }));
  } else {
    // Active period: project winners from the live standings + tier table.
    const snapshots = await db.race_leaderboard_snapshots.findMany({
      where: { race_type: kind, period_start: new Date(periodStartDateString) },
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
 * /rewards/analytics. Drives the breakdown popover anchored on that
 * tile — admins can see which race type (daily / weekly / monthly)
 * drove the total without leaving the page.
 *
 * Single `race_claims` GROUP BY race_type aggregate. Sorted DESC by
 * total so the loudest race type surfaces at the top. Includes every
 * race_type, including monthly even though it isn't a section on
 * /rewards/analytics — the headline KPI sums every type, so the
 * breakdown does too (by construction the rows total to the
 * headline).
 *
 * Race-claim totals deliberately INCLUDE staff / blacklisted users
 * for the same reason the underlying `getRewardsLeaderboards` does:
 * race-position queries stay raw so leaderboard positions don't
 * shift when an exclusion lands.
 */
export async function getLifetimePrizesBreakdown(): Promise<LifetimePrizesBreakdown> {
  const db = await getDb();
  const rows = await db.race_claims.groupBy({
    by: ["race_type"],
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
 * Top lifetime prize winners across every race type. Drives the
 * lazy expander inside the "Lifetime prizes paid" popover so admins
 * can see WHO has cumulatively walked away with the most prize money
 * (single-query view that spans every race type).
 *
 * Lazy on click (heavier GROUP BY user_id over race_claims). Joins
 * to `user` for the username so the popover row can link straight
 * to /users/<id>.
 */
export async function getLifetimePrizesTopWinners(
  limit = 10,
): Promise<LifetimePrizesTopWinner[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const db = await getDb();
  const rows = await db.$queryRaw<
    {
      user_id: string;
      username: string | null;
      total: string;
      claims: string;
    }[]
  >`
    SELECT
      rc.user_id,
      u.username,
      SUM(rc.prize_amount_usd::numeric)::text AS total,
      COUNT(*)::text AS claims
    FROM race_claims rc
    JOIN "user" u ON u.id = rc.user_id
    GROUP BY rc.user_id, u.username
    ORDER BY SUM(rc.prize_amount_usd::numeric) DESC
    LIMIT ${safeLimit}
  `;
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
 * `race_prize_tiers` for the requested race types, sorted by race
 * type then position. Drives the breakdown popover on the "Per-race
 * prize budget" KPI tile so admins can see exactly which positions
 * carry which prize amounts without opening /rewards/leaderboards.
 *
 * `raceTypes` parameter is a strict allow-list of `race_type` enum
 * values — caller passes the same set the headline KPI sums so the
 * rows reconcile by construction.
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

  // Lifetime sum of paid prizes is independent of any specific period —
  // it spans every race_claims row ever filed. We INCLUDE monthly here
  // intentionally: the KPI is "total prize money paid by the platform's
  // own leaderboards", and monthly is one of those leaderboards even if
  // it isn't surfaced as its own section on this page.
  const [daily, weekly, lifetimeRow] = await Promise.all([
    buildRaceSummary("daily"),
    buildRaceSummary("weekly"),
    db.race_claims.aggregate({
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
