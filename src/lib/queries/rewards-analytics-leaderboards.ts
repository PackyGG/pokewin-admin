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
