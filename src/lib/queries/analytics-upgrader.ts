import "server-only";

import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";

/**
 * Upgrader analytics for /analytics → Games → Upgrader.
 *
 * The tab used to render `getUpgraderStats()` — the DASHBOARD's card read,
 * which is lifetime-only by design. That left the Games tab with a period
 * chip that did nothing and no trend at all: the same nine numbers whichever
 * window you picked. This module is the period-aware twin: the same
 * primitives, over the selected window, plus the per-day series the tab
 * needs to draw a trend.
 *
 * SOURCE OF TRUTH — `upgrader_games` (`bet_amount` + `won_amount` per play),
 * identical to `upgraderMetrics` in `@/lib/metrics/queries`. The owner
 * confirmed upgrader lives ONLY in this table; the ledger does NOT carry
 * `upgrader_bet` / `upgrader_payout` rows, so nothing here touches it.
 * `won_amount` is the GROSS amount credited on a win (0 on a loss), so
 * wager − payout is the true house margin with no ledger round-trip.
 *
 * SCOPE — the same real-customer predicate the canonical layer uses
 * (admin / support / creator dropped + the excluded-users blacklist), so
 * these numbers reconcile with the dashboard card and with the canonical
 * `upgraderMetrics` for the same window.
 *
 * ─── PostgreSQL index policy (CLAUDE.md) ───────────────────────────────
 *
 * This read is Path 1 with a DOCUMENTED seq scan, verified read-only against
 * prod with EXPLAIN (ANALYZE, BUFFERS) on 2026-07-23:
 *
 *   upgrader_games: 120,571 rows / 45 MB, fully resident in shared buffers
 *   (shared hit=4268, read=0). 30d window → Seq Scan + Hash Join, 41 ms.
 *
 * A `created_at` index would NOT be chosen by the planner here and is not
 * worth requesting: the 30d window already selects ~19% of a small, fully
 * cached table, which is exactly the shape where a seq scan wins. This is
 * also STRICTLY CHEAPER than what the tab did before — that was an
 * unbounded lifetime scan of the same table on every render.
 *
 * One statement returns the per-day series, the window totals (summed from
 * the same rows in JS) AND the window-wide distinct-player count, so the
 * whole tab costs a single mirror read after the table probe.
 */

export type UpgraderPeriod = "today" | "7d" | "30d" | "90d" | "all";

/** One UTC day of upgrader play. House POV: `pnl` > 0 = the house kept it. */
export type UpgraderDailyPoint = {
  /** UTC day key, "yyyy-MM-dd". */
  bucket: string;
  wager: number;
  payout: number;
  /** wager − payout for the day. */
  pnl: number;
  /** Running total of `pnl` across the window. */
  cumPnl: number;
  bets: number;
};

export type UpgraderAnalytics = {
  period: UpgraderPeriod;
  wager: number;
  payout: number;
  /** wager − payout. Positive = house kept it. */
  pnl: number;
  /** Measured hold as a FRACTION (0.1 = 10%), not a percentage. */
  edge: number;
  bets: number;
  avgBet: number;
  uniquePlayers: number;
  wins: number;
  losses: number;
  /** Win rate as a FRACTION (0.3 = 30%), not a percentage. */
  hitRate: number;
  daily: UpgraderDailyPoint[];
};

/**
 * Returned when the connected DB predates the upgrader (no `upgrader_games`
 * table), so the tab renders an empty state instead of a 42P01 error.
 */
function emptyAnalytics(period: UpgraderPeriod): UpgraderAnalytics {
  return {
    period,
    wager: 0,
    payout: 0,
    pnl: 0,
    edge: 0,
    bets: 0,
    avgBet: 0,
    uniquePlayers: 0,
    wins: 0,
    losses: 0,
    hitRate: 0,
    daily: [],
  };
}

// Lifetime (`all`) is capped at this lookback rather than an unbounded
// full-history scan — the pattern CLAUDE.md ("Performance & Daten-Laden")
// forbids. Matches the house `INSIGHTS_LIFETIME_LOOKBACK_DAYS` convention.
// Upgrader's first play is 2026-05-27, so 365d covers all of it today; the
// cap exists so the query stays bounded as history grows.
const LIFETIME_LOOKBACK_DAYS = 365;

function daysForPeriod(period: UpgraderPeriod): number {
  switch (period) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return LIFETIME_LOOKBACK_DAYS;
  }
}

export function upgraderPeriodLabel(period: UpgraderPeriod): string {
  switch (period) {
    case "today":
      return "Last 24 hours";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "all":
      return "Lifetime";
  }
}

async function computeUpgraderAnalytics(
  period: UpgraderPeriod,
  excluded: string[],
): Promise<UpgraderAnalytics> {
  const db = await getReadDrizzleDb();

  // Probe: skip entirely if the table is absent (pre-upgrader DB).
  // to_regclass returns NULL (not an error) for a missing relation — same
  // guard the canonical `upgraderMetrics` uses.
  const probe = await queryRows<{ exists: string | null }[]>(
    db,
    "SELECT to_regclass('public.upgrader_games')::text AS exists",
  );
  if (probe[0]?.exists == null) return emptyAnalytics(period);

  const blacklist = blacklistNotInClause("id", excluded);
  const days = daysForPeriod(period);

  type Row = {
    bucket: Date;
    wager: string;
    payout: string;
    bets: string;
    wins: string;
    window_players: string;
  };
  // ONE statement for the whole tab: per-day rows plus the window-wide
  // unique-player count, totals derived in JS.
  //
  // The window count CANNOT be summed from the daily rows (a player who
  // played on two days would be counted twice), so it used to be a SECOND
  // round trip repeating the exact same filtered scan. It is now a
  // single-row `window_total` CTE cross-joined onto every day bucket: same
  // arithmetic, same number, one read instead of two. That matters more than
  // it looks — mirror reads pass through a process-wide admission semaphore
  // (`src/lib/db.ts`), so a duplicated scan consumes a slot every other
  // section on the page is queueing for.
  const rows = await queryRows<Row[]>(db,
    `WITH real_users AS (
       SELECT id FROM "user"
       WHERE role NOT IN ('admin', 'support', 'creator') ${blacklist}
     ),
     plays AS (
       SELECT user_id, created_at, bet_amount, won_amount
       FROM upgrader_games
       WHERE user_id IN (SELECT id FROM real_users)
         AND created_at >= NOW() - INTERVAL '${days} days'
     ),
     window_total AS (
       SELECT COUNT(DISTINCT user_id)::text AS players FROM plays
     )
     SELECT
       DATE(p.created_at)                                          AS bucket,
       COALESCE(SUM(p.bet_amount::numeric), 0)::text               AS wager,
       COALESCE(SUM(p.won_amount::numeric), 0)::text               AS payout,
       COUNT(*)::text                                              AS bets,
       COUNT(CASE WHEN p.won_amount::numeric > 0 THEN 1 END)::text AS wins,
       w.players                                                   AS window_players
     FROM plays p
     CROSS JOIN window_total w
     GROUP BY DATE(p.created_at), w.players
     ORDER BY bucket`,
  );

  let cumPnl = 0;
  const daily: UpgraderDailyPoint[] = rows.map((r) => {
    const wager = toNumber(r.wager);
    const payout = toNumber(r.payout);
    const pnl = wager - payout;
    cumPnl += pnl;
    return {
      bucket: new Date(r.bucket).toISOString().split("T")[0],
      wager,
      payout,
      pnl,
      cumPnl,
      bets: toNumber(r.bets),
    };
  });

  const wager = daily.reduce((a, d) => a + d.wager, 0);
  const payout = daily.reduce((a, d) => a + d.payout, 0);
  const bets = daily.reduce((a, d) => a + d.bets, 0);
  const wins = rows.reduce((a, r) => a + toNumber(r.wins), 0);
  const pnl = wager - payout;

  return {
    period,
    wager,
    payout,
    pnl,
    // Fractions, NOT percentages — the caller formats. The dashboard's
    // `getUpgraderStats` returns these ALREADY multiplied by 100, which is
    // exactly the mismatch that made the Games tab print a 10% hold as
    // "1000.00%". Keeping the raw fraction here removes the ambiguity.
    edge: wager > 0 ? pnl / wager : 0,
    bets,
    avgBet: bets > 0 ? wager / bets : 0,
    // Same on every row (single-row CROSS JOIN); no rows at all means no
    // plays in the window, which is 0 players — matching the old separate
    // aggregate exactly.
    uniquePlayers: toNumber(rows[0]?.window_players),
    wins,
    losses: Math.max(0, bets - wins),
    hitRate: bets > 0 ? wins / bets : 0,
    daily,
  };
}

/**
 * Cross-request cache. /analytics re-runs on every 5-minute `AutoRefresh`
 * tick for every viewer; without a shared cache the scan re-ran per tick per
 * viewer. 60s for the finite windows, 300s for the lifetime view — the same
 * two-layer idiom the other analytics reads use, keyed on
 * `(period, sortedBlacklist)`.
 */
const cachedUpgraderAnalytics = unstable_cache(
  computeUpgraderAnalytics,
  ["analytics-upgrader-v1"],
  { revalidate: 60, tags: ["analytics"] },
);

const cachedUpgraderAnalyticsLifetime = unstable_cache(
  computeUpgraderAnalytics,
  ["analytics-upgrader-lifetime-v1"],
  { revalidate: 300, tags: ["analytics"] },
);

export async function getUpgraderAnalytics(
  period: UpgraderPeriod,
): Promise<UpgraderAnalytics> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return withTiming("analytics.upgrader", () =>
    period === "all"
      ? cachedUpgraderAnalyticsLifetime(period, sorted)
      : cachedUpgraderAnalytics(period, sorted),
  );
}
