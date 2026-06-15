import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { toNumber } from "@/lib/utils/decimal";
import type {
  RaceLeaderboardKind,
  RaceLeaderboardSummary,
  RaceLeaderboardWinnerRow,
  RewardsLeaderboardsData,
} from "@/lib/queries/rewards-analytics-leaderboards";

import { CH_DB, customerScopeCte } from "../_shared";

/**
 * ClickHouse twin of `getRewardsLeaderboards`
 * (`src/lib/queries/rewards-analytics-leaderboards.ts`) — platform daily +
 * weekly cash-race summaries + lifetime prize payout for /rewards/analytics.
 *
 * PARITY: lifetime prizes paid = Σ `race_claims.prize_amount_usd` + claim count
 * (scoped); per race type: prize pool = Σ `race_prize_tiers.prize_amount_usd`
 * (catalog, unscoped) + tier count; top-5 winners = the active period's top-5
 * snapshots (prize projected from the tier amount) OR, when the chosen period
 * is ended, the top-5 race_claims by position (wagered paired from the matching
 * snapshot). Period selection mirrors PG: prefer the latest `active` period,
 * else the latest `ended` period.
 *
 * SCOPE (mirrors PG EXACTLY): every user-scoped aggregate uses the wholesale
 * customer scope `role NOT IN ('admin','support','creator')` + blacklist
 * (`customerScopeCte`), matching `excludeStaffCreatorsAndBlacklisted*`. The
 * tier catalog (prize pool / positions) carries no user scope, like PG.
 *
 * NOTE (§5c): the active-period top-5 projection pairs live leaderboard
 * snapshots with tier amounts and tracks live wagering, so it is the volatile
 * sub-leg — the compare diffs the deterministic aggregates (lifetime totals +
 * prize pool/positions) and the top-winner aggregate, which is stable for an
 * ended period and CDC-lag/live-projection sensitive for an active one.
 */

const TOP_WINNERS_LIMIT = 5;

type LifetimeRow = { total: string; cnt: string };
type TierRow = { position: string; prize: string };
type PeriodRow = {
  status: string;
  start_date: string;
  starts_at: string;
  ends_at: string;
};
type EndedWinnerRow = {
  user_id: string;
  username: string | null;
  position: string;
  prize: string;
  wagered: string | null;
};
type ActiveWinnerRow = {
  user_id: string;
  username: string | null;
  position: string;
  wagered: string;
};

async function buildRaceSummary(
  kind: RaceLeaderboardKind,
  blacklist: string[],
): Promise<RaceLeaderboardSummary> {
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });
  const params: Record<string, unknown> = { blacklist };

  const [tiers, periods] = await Promise.all([
    clickhouseRead.query<TierRow>({
      queryName: "rewards.analytics.leaderboards.tiers",
      sql: `
        SELECT toString(t.position) AS position, toString(t.prize_amount_usd) AS prize
        FROM ${CH_DB}.public_race_prize_tiers AS t FINAL
        WHERE t._peerdb_is_deleted = 0 AND t.race_type = '${kind}'
        ORDER BY t.position ASC`,
    }),
    clickhouseRead.query<PeriodRow>({
      queryName: "rewards.analytics.leaderboards.periods",
      sql: `
        SELECT
          rp.status                          AS status,
          toString(toDate(rp.starts_at))     AS start_date,
          toString(rp.starts_at)             AS starts_at,
          toString(rp.ends_at)               AS ends_at
        FROM ${CH_DB}.public_race_periods AS rp FINAL
        WHERE rp._peerdb_is_deleted = 0
          AND rp.race_type = '${kind}'
          AND rp.status IN ('active','ended')`,
    }),
  ]);

  const prizePool = tiers.reduce((a, t) => a + toNumber(t.prize), 0);
  const prizePositions = tiers.length;
  const tierByPosition = new Map(
    tiers.map((t) => [Number(t.position), toNumber(t.prize)] as const),
  );

  const activePeriods = periods
    .filter((p) => p.status === "active")
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  const endedPeriods = periods
    .filter((p) => p.status === "ended")
    .sort((a, b) => b.ends_at.localeCompare(a.ends_at));
  const activePeriod = activePeriods[0] ?? null;
  const recentEndedPeriod = endedPeriods[0] ?? null;

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
  const startDate = String(chosen.start_date).slice(0, 10);

  let topWinners: RaceLeaderboardWinnerRow[] = [];

  if (state === "ended") {
    const rows = await clickhouseRead.query<EndedWinnerRow>({
      queryName: "rewards.analytics.leaderboards.ended-winners",
      sql: `
        WITH ${scope}
        SELECT
          rc.user_id                       AS user_id,
          u.username                       AS username,
          toString(rc.position)            AS position,
          toString(rc.prize_amount_usd)    AS prize,
          toString(rls.wagered_usd)        AS wagered
        FROM ${CH_DB}.public_race_claims AS rc FINAL
        LEFT JOIN ${CH_DB}.public_user AS u FINAL
          ON u.id = rc.user_id AND u._peerdb_is_deleted = 0
        LEFT JOIN ${CH_DB}.public_race_leaderboard_snapshots AS rls FINAL
          ON rls.user_id = rc.user_id
         AND rls.race_type = rc.race_type
         AND rls.period_start = rc.race_period_start
         AND rls._peerdb_is_deleted = 0
        WHERE rc._peerdb_is_deleted = 0
          AND rc.race_type = '${kind}'
          AND rc.race_period_start = {startDate:Date}
          AND rc.user_id IN (SELECT id FROM real_users)
        ORDER BY rc.position ASC
        LIMIT ${TOP_WINNERS_LIMIT}`,
      params: { ...params, startDate },
    });
    topWinners = rows.map((r) => ({
      position: Number(r.position),
      userId: r.user_id,
      username: r.username,
      prizeAmountUsd: toNumber(r.prize),
      wageredUsd: r.wagered != null ? toNumber(r.wagered) : 0,
    }));
  } else {
    const rows = await clickhouseRead.query<ActiveWinnerRow>({
      queryName: "rewards.analytics.leaderboards.active-winners",
      sql: `
        WITH ${scope}
        SELECT
          rls.user_id                AS user_id,
          u.username                 AS username,
          toString(rls.position)     AS position,
          toString(rls.wagered_usd)  AS wagered
        FROM ${CH_DB}.public_race_leaderboard_snapshots AS rls FINAL
        LEFT JOIN ${CH_DB}.public_user AS u FINAL
          ON u.id = rls.user_id AND u._peerdb_is_deleted = 0
        WHERE rls._peerdb_is_deleted = 0
          AND rls.race_type = '${kind}'
          AND rls.period_start = {startDate:Date}
          AND rls.user_id IN (SELECT id FROM real_users)
        ORDER BY rls.position ASC
        LIMIT ${TOP_WINNERS_LIMIT}`,
      params: { ...params, startDate },
    });
    topWinners = rows.map((r) => ({
      position: Number(r.position),
      userId: r.user_id,
      username: r.username,
      prizeAmountUsd: tierByPosition.get(Number(r.position)) ?? 0,
      wageredUsd: toNumber(r.wagered),
    }));
  }

  return {
    kind,
    state,
    periodStart: chosen.starts_at,
    periodEnd: chosen.ends_at,
    prizePool,
    prizePositions,
    topWinners,
  };
}

export async function getRewardsLeaderboardsFromClickHouse(
  blacklist: string[],
): Promise<RewardsLeaderboardsData> {
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const [daily, weekly, lifetimeRows] = await Promise.all([
    buildRaceSummary("daily", blacklist),
    buildRaceSummary("weekly", blacklist),
    clickhouseRead.query<LifetimeRow>({
      queryName: "rewards.analytics.leaderboards.lifetime",
      sql: `
        WITH ${scope}
        SELECT
          toString(sum(rc.prize_amount_usd)) AS total,
          toString(count())                  AS cnt
        FROM ${CH_DB}.public_race_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.user_id IN (SELECT id FROM real_users)`,
      params: { blacklist },
    }),
  ]);

  const lr = lifetimeRows[0] ?? { total: "0", cnt: "0" };
  return {
    daily,
    weekly,
    lifetimePrizesPaid: toNumber(lr.total),
    lifetimeClaimsCount: Number(lr.cnt),
  };
}
