import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { excludeStaffCreatorsAndBlacklistedSqlFromIds } from "@/lib/queries/_blacklist";

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
  return excludeStaffCreatorsAndBlacklistedSqlFromIds(excluded);
}

/**
 * Build the leaderboard summary for a single race type (daily or weekly).
 */
async function buildRaceSummary(
  kind: RaceLeaderboardKind,
): Promise<RaceLeaderboardSummary> {
  const userScopeSql = await raceClaimsUserScopeSql();
  type TierRow = { position: number; prize_amount_usd: string };
  type PeriodRow = {
    starts_at: Date | string;
    ends_at: Date | string;
  };

  const [tiers, activePeriod, recentEndedPeriod] = await Promise.all([
    queryMainRows<TierRow[]>(
      `SELECT position, prize_amount_usd::text AS prize_amount_usd
       FROM race_prize_tiers
       WHERE race_type::text = $1
       ORDER BY position ASC`,
      kind,
    ),
    queryMainRows<PeriodRow[]>(
      `SELECT starts_at, ends_at FROM race_periods
       WHERE race_type::text = $1 AND status::text = 'active'
       ORDER BY starts_at DESC LIMIT 1`,
      kind,
    ).then((rows) => rows[0] ?? null),
    queryMainRows<PeriodRow[]>(
      `SELECT starts_at, ends_at FROM race_periods
       WHERE race_type::text = $1 AND status::text = 'ended'
       ORDER BY ends_at DESC LIMIT 1`,
      kind,
    ).then((rows) => rows[0] ?? null),
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
  const periodStart = new Date(chosen.starts_at);
  const periodEnd = new Date(chosen.ends_at);
  const periodStartDateString = periodStart.toISOString().slice(0, 10);

  let topWinners: RaceLeaderboardWinnerRow[] = [];

  if (state === "ended") {
    const rows = await queryMainRows<
      {
        user_id: string;
        username: string | null;
        position: number;
        prize_amount_usd: string;
        wagered_usd: string | null;
      }[]
    >(
      `
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
      WHERE rc.race_type::text = $1
        AND rc.race_period_start = $2::date
        AND rc.${userScopeSql}
      ORDER BY rc.position ASC
      LIMIT $3
    `,
      kind,
      periodStartDateString,
      TOP_WINNERS_LIMIT,
    );
    topWinners = rows.map((r) => ({
      position: r.position,
      userId: r.user_id,
      username: r.username,
      prizeAmountUsd: toNumber(r.prize_amount_usd),
      wageredUsd: r.wagered_usd ? toNumber(r.wagered_usd) : 0,
    }));
  } else {
    // `position` on race_leaderboard_snapshots is only finalized once the
    // period ends (a backend job assigns 1..N by wagered_usd desc at that
    // point) — while active it stays 0 for every row (verified read-only
    // against prod), so ordering by it here would return an arbitrary set of
    // "winners", not the top wagerers. Rank live by wagered_usd instead; this
    // matches exactly how position gets finalized once the period ends.
    const snapshotScope = userScopeSql.replace(/^user_id/, "rls.user_id");
    const snapshots = await queryMainRows<{
      user_id: string;
      username: string | null;
      wagered_usd: string;
    }[]>(
      `SELECT rls.user_id, u.username,
              rls.wagered_usd::text AS wagered_usd
       FROM race_leaderboard_snapshots rls
       LEFT JOIN "user" u ON u.id = rls.user_id
       WHERE rls.race_type::text = $1
         AND rls.period_start = $2::date
         AND ${snapshotScope}
       ORDER BY rls.wagered_usd DESC, rls.user_id ASC
       LIMIT $3`,
      kind,
      periodStartDateString,
      TOP_WINNERS_LIMIT,
    );
    topWinners = snapshots.map((s, i) => ({
      position: i + 1,
      userId: s.user_id,
      username: s.username,
      prizeAmountUsd: tierByPosition.get(i + 1) ?? 0,
      wageredUsd: toNumber(s.wagered_usd),
    }));
  }

  return {
    kind,
    state,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
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
  const scope = await raceClaimsUserScopeSql();
  const rows = await queryMainRows<{
    race_type: string;
    total: string;
    claims: string;
  }[]>(
    `SELECT rc.race_type::text AS race_type,
            COALESCE(SUM(rc.prize_amount_usd::numeric), 0)::text AS total,
            COUNT(*)::text AS claims
     FROM race_claims rc
     WHERE rc.${scope}
     GROUP BY rc.race_type`,
  );
  const byRaceType: LifetimePrizesByRaceType[] = rows
    .map((r) => ({
      raceType: r.race_type,
      total: toNumber(r.total),
      claims: Number(r.claims),
    }))
    .sort((a, b) => b.total - a.total);
  const total = byRaceType.reduce((a, r) => a + r.total, 0);
  const claims = byRaceType.reduce((a, r) => a + r.claims, 0);
  return { byRaceType, total, claims };
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
  const tiers =
    raceTypes.length === 0
      ? []
      : await queryMainRows<{
          race_type: string;
          position: number;
          prize_amount_usd: string;
        }[]>(
          `SELECT race_type::text AS race_type, position,
                  prize_amount_usd::text AS prize_amount_usd
           FROM race_prize_tiers
           WHERE race_type::text = ANY($1::text[])
           ORDER BY race_type ASC, position ASC`,
          raceTypes,
        );
  const rows: PrizeBudgetTierRow[] = tiers.map((t) => ({
    raceType: t.race_type,
    position: t.position,
    prizeAmountUsd: toNumber(t.prize_amount_usd),
  }));
  const total = rows.reduce((a, r) => a + r.prizeAmountUsd, 0);
  return { rows, total };
}

export async function getRewardsLeaderboards(): Promise<RewardsLeaderboardsData> {
  const scope = await raceClaimsUserScopeSql();

  const [daily, weekly, lifetimeRow] = await Promise.all([
    buildRaceSummary("daily"),
    buildRaceSummary("weekly"),
    queryMainRows<{ total: string; count: string }[]>(
      `SELECT COALESCE(SUM(rc.prize_amount_usd::numeric), 0)::text AS total,
              COUNT(*)::text AS count
       FROM race_claims rc
       WHERE rc.${scope}`,
    ).then((rows) => rows[0]),
  ]);

  return {
    daily,
    weekly,
    lifetimePrizesPaid: toNumber(lifetimeRow?.total),
    lifetimeClaimsCount: Number(lifetimeRow?.count ?? 0),
  };
}
