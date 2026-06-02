import { cache } from "react";
import { unstable_cache } from "next/cache";
import { withTiming } from "@/lib/observability/query-timings";
import { upgraderMetrics } from "@/lib/metrics/queries";

/**
 * Upgrader Stats section on /dashboard. Lifetime-only after the perf
 * pass: the previous 9-period CASE-WHEN computation has been collapsed
 * to a single aggregate, and the client-side chip selector is gone.
 *
 * SOURCE OF TRUTH — `upgrader_games`, via the canonical
 * `@/lib/metrics/queries` `upgraderMetrics`. The owner confirms upgrader
 * lives ONLY in `upgrader_games` (`bet_amount` + `won_amount` per play);
 * the ledger does NOT carry `upgrader_bet` / `upgrader_payout` rows (M6).
 * The canonical helper bakes in the SAME real-customer scope (admin /
 * support / creator + blacklist dropped) the rest of `@/lib/metrics`
 * uses and is `to_regclass`-guarded, so it degrades to `null` on a
 * pre-upgrader DB rather than throwing `42P01`.
 *
 * This section computes the presentation-only derived ratios on top of
 * the canonical primitives:
 *   wager   = canonical wager   — what players risked (SUM bet_amount)
 *   payouts = canonical payout  — gross value returned (SUM won_amount)
 *   pnl     = canonical ggr (= wager − payouts; positive = house gained)
 *   edge    = pnl / wager * 100 (house edge %)
 *   avgBet  = wager / bets
 *   hitRate = wins / bets * 100
 *   wins / losses / bets / uniquePlayers — straight from the canonical read
 *
 * `won_amount` is the GROSS amount credited on a win (0 on a loss), so
 * wager − payouts is the true house margin without any ledger round-trip.
 */
export type UpgraderStats = {
  wager: number;
  payouts: number;
  pnl: number;
  edge: number;
  bets: number;
  avgBet: number;
  uniquePlayers: number;
  wins: number;
  losses: number;
  hitRate: number;
};

/** Zeroed stats — returned when the connected DB has no `upgrader_games`
 *  table (the pre-upgrader snapshot), so the section renders an empty
 *  state instead of erroring. */
const EMPTY_UPGRADER_STATS: UpgraderStats = {
  wager: 0,
  payouts: 0,
  pnl: 0,
  edge: 0,
  bets: 0,
  avgBet: 0,
  uniquePlayers: 0,
  wins: 0,
  losses: 0,
  hitRate: 0,
};

/**
 * 5-minute cross-request cache. The Upgrader section is lifetime data
 * that drifts very slowly compared to the dashboard's wager / PnL
 * tiles, so a 5-minute floor is invisible to operators and saves the
 * full scan over `upgrader_games` on each 60s dashboard refresh.
 * The 5-minute TTL matches the realized P&L snapshot's cache.
 */
const cachedUpgraderStats = unstable_cache(
  upgraderStatsInner,
  ["dashboard-upgrader-lifetime-v3"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

export const getUpgraderStats = cache(async (): Promise<UpgraderStats> => {
  return withTiming("dashboard.upgrader", () => cachedUpgraderStats());
});

async function upgraderStatsInner(): Promise<UpgraderStats> {
  // Lifetime window (`since: null`) — the canonical helper applies the
  // real-customer scope + the to_regclass guard internally.
  const m = await upgraderMetrics({ since: null });
  if (m === null) return EMPTY_UPGRADER_STATS;

  const { wager, payout, ggr, bets, uniquePlayers, wins, losses } = m;
  return {
    wager,
    payouts: payout,
    pnl: ggr,
    edge: wager > 0 ? (ggr / wager) * 100 : 0,
    bets,
    avgBet: bets > 0 ? wager / bets : 0,
    uniquePlayers,
    wins,
    losses,
    hitRate: bets > 0 ? (wins / bets) * 100 : 0,
  };
}
