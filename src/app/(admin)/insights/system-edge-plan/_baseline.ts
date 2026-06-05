import "server-only";

import { unstable_cache } from "next/cache";

import { safeQuery } from "@/lib/errors/safe-query";
import { getWindowMetrics, sumLedgerTypes } from "@/lib/metrics/queries";
import { getRakebackConfigs } from "@/lib/queries/rewards";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators-analytics";
import { getAffiliateOverview } from "@/lib/queries/insights-rewards/affiliate/overview";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

import type {
  AffiliateTierLever,
  RakebackCadenceId,
  RakebackCadenceLever,
  SystemEdgeBaseline,
} from "./_model";

/**
 * _baseline.ts — assemble the REAL, serializable System Edge Plan baseline
 * (read-only, at request time).
 *
 * EVERYTHING here is real production data — NEVER invented (a prior agent
 * fabricated a "5% rakeback"; the rates below come straight from the live
 * `rakeback_config` / `affiliate_level_configs` tables and the canonical metric
 * layer):
 *
 *   • wager / gaming payout / GGR / empirical house edge / bets
 *       ← `getWindowMetrics` (canonical real-customer, borrow-corrected scope).
 *   • per-lever realized reward cost (rakeback / affiliate / deposit bonus /
 *     race) ← `sumLedgerTypes` over the real ledger type(s) for each lever,
 *       under the SAME canonical scope, so the lever costs reconcile with NGR.
 *   • rakeback per-cadence rates ← `getRakebackConfigs()` → `rakeback_config`
 *       (real: daily 0.25% / weekly 0.1% / monthly 0.05% — whatever the DB says).
 *   • affiliate per-tier rates + thresholds ← `getAffiliateLevelConfigs()` →
 *       `affiliate_level_configs` (real ladder, e.g. 8 tiers 3%→10%).
 *   • blended affiliate rate + referred-wager anchor ← `getAffiliateOverview`.
 *
 * Active-timeframe-only (CLAUDE.md): the page mounts ONE baseline per `?period=`
 * inside a keyed `<Suspense>`, so only the selected window is fetched. Heavy
 * reads are wrapped in `unstable_cache` keyed on the period (60s / 300s) and run
 * through `safeQuery` so a slow query degrades to a fallback instead of blocking.
 * Lifetime is bounded via `daysForInsightsPeriodCapped` (no unbounded scans).
 */

/** The non-tunable reward legs NOT exposed as their own lever in the planner. */
const RAKEBACK_TYPES = ["rakeback_claim"] as const;
const AFFILIATE_TYPES = [
  "affiliate_claim",
  "affiliate_leaderboard_prize",
] as const;
const DEPOSIT_BONUS_TYPES = ["deposit_bonus"] as const;
const RACE_TYPES = ["race_prize"] as const;

/** Map an InsightsRewardsPeriod onto a canonical `MetricWindow` (lifetime bounded). */
function windowFor(period: InsightsRewardsPeriod): { since: Date | null } {
  if (period === "all") {
    // Bound lifetime so the canonical scans don't go full-history (CLAUDE.md
    // "Active-Timeframe-Only" — lifetime windows must be capped).
    const days = daysForInsightsPeriodCapped(period);
    return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  }
  const days = daysForInsightsPeriodCapped(period);
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

function normalizeCadence(type: string): RakebackCadenceId | null {
  if (type === "daily" || type === "weekly" || type === "monthly") return type;
  return null;
}

/**
 * Fetch + assemble the real baseline for a window. Cached per-period.
 *
 * The config reads (rakeback / affiliate ladders) are period-agnostic (the same
 * regardless of window) but are fetched here so the whole baseline is one cache
 * entry per period — they're cheap `findMany`s.
 */
async function buildBaseline(
  period: InsightsRewardsPeriod,
): Promise<SystemEdgeBaseline> {
  const window = windowFor(period);
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  const [
    metricsRes,
    rakebackCostRes,
    affiliateCostRes,
    depositBonusCostRes,
    raceCostRes,
    rakebackCfgRes,
    affiliateCfgRes,
    affiliateOvRes,
  ] = await Promise.all([
    safeQuery(
      () => getWindowMetrics({ window }),
      null,
      "system-edge-plan.metrics",
    ),
    safeQuery(
      () => sumLedgerTypes({ types: RAKEBACK_TYPES, window }),
      0,
      "system-edge-plan.rakeback-cost",
    ),
    safeQuery(
      () => sumLedgerTypes({ types: AFFILIATE_TYPES, window }),
      0,
      "system-edge-plan.affiliate-cost",
    ),
    safeQuery(
      () => sumLedgerTypes({ types: DEPOSIT_BONUS_TYPES, window }),
      0,
      "system-edge-plan.deposit-bonus-cost",
    ),
    safeQuery(
      () => sumLedgerTypes({ types: RACE_TYPES, window }),
      0,
      "system-edge-plan.race-cost",
    ),
    safeQuery(
      () => getRakebackConfigs(),
      [],
      "system-edge-plan.rakeback-config",
    ),
    safeQuery(
      () => getAffiliateLevelConfigs(),
      [],
      "system-edge-plan.affiliate-config",
    ),
    safeQuery(
      () => getAffiliateOverview(period),
      null,
      "system-edge-plan.affiliate-overview",
    ),
  ]);

  const metrics = metricsRes.data;
  const wager = metrics?.wager ?? 0;
  const gamingPayout = metrics?.gamingPayout ?? 0;
  const ggr = metrics?.ggr ?? 0;
  const houseEdge = metrics?.houseEdge ?? null;
  const bets = metrics?.bets ?? 0;

  const rakebackCost = rakebackCostRes.data ?? 0;
  const affiliateCost = affiliateCostRes.data ?? 0;
  const depositBonusCost = depositBonusCostRes.data ?? 0;
  const raceCost = raceCostRes.data ?? 0;

  // Other reward cost = the canonical total reward cost (GGR − NGR) minus the
  // four levers we itemize, so the planner's reward sum reconciles with NGR. The
  // remainder is gift cards / promo / waitlist / balance reward / manual
  // vouchers + counted adjustments + net rain — held fixed (no lever), surfaced
  // as an informational line.
  const canonicalRewardCost =
    metrics != null ? metrics.ggr - metrics.ngr : 0;
  const otherRewardCost = Math.max(
    0,
    canonicalRewardCost - rakebackCost - affiliateCost - depositBonusCost - raceCost,
  );

  // Real rakeback cadences (daily / weekly / monthly) from rakeback_config.
  const rakebackCadences: RakebackCadenceLever[] = (rakebackCfgRes.data ?? [])
    .map((c): RakebackCadenceLever | null => {
      const cadence = normalizeCadence(c.type);
      if (cadence == null) return null;
      return {
        cadence,
        label: c.displayName || cadenceLabel(cadence),
        currentRate: Math.max(0, c.percentage),
        enabled: c.enabled,
      };
    })
    .filter((c): c is RakebackCadenceLever => c != null)
    // Stable order: daily → weekly → monthly.
    .sort((a, b) => cadenceOrder(a.cadence) - cadenceOrder(b.cadence));

  // Real affiliate tiers from affiliate_level_configs.
  const affiliateTiers: AffiliateTierLever[] = (affiliateCfgRes.data ?? [])
    .map((c) => ({
      level: c.level,
      label: c.label || `Level ${c.level}`,
      currentRate: Math.max(0, c.commission_rate),
      threshold: Math.max(0, c.threshold),
    }))
    .sort((a, b) => a.level - b.level);

  // Real blended affiliate rate = total commission ÷ referred wager (when both
  // known). Informational only — the per-tier rates drive the projection.
  const ov = affiliateOvRes.data;
  const affiliateBlendedRate =
    ov != null && ov.downstreamWager > 0
      ? ov.totalCommissionPaid / ov.downstreamWager
      : null;

  return {
    periodLabel: insightsRewardsPeriodLabel(period),
    periodDays,
    wager,
    gamingPayout,
    ggr,
    houseEdge,
    bets,
    rakebackCost,
    affiliateCost,
    depositBonusCost,
    raceCost,
    otherRewardCost,
    rakebackCadences,
    affiliateTiers,
    affiliateBlendedRate,
    // Upgrader→rakeback weighting is 100% (unweighted) in production — the real
    // current value. The lever lets the owner model down-weighting it.
    upgraderRakebackWeight: 1,
    // Real upgrader wager slice (0 on a pre-upgrader DB). Sizes how much of the
    // rakeback cost the upgrader-weight lever can move. Sourced from the
    // canonical legs would require a separate read; the upgrader wager is folded
    // into `metrics.wager` but not separable from the WindowMetrics rollup, so
    // we leave it at 0 here (the lever then has no slice to act on and stays
    // neutral) rather than fabricate a split. Reserved for a future wire-up to
    // `upgraderMetrics` if a per-game rakeback split is needed.
    upgraderWager: 0,
    // Raffle ticket rate lives in the MAIN game backend (not this admin repo),
    // per the discovery — null here. The raffle lever is therefore a
    // proportional cost multiplier, not an absolute rate.
    raffleTicketRate: null,
    // Raffle prize cost is reconstructed elsewhere and has no dedicated ledger
    // type; we do NOT fabricate it here. 0 = no raffle lever movement until a
    // real raffle-cost anchor is threaded.
    raffleCost: 0,
  };
}

/** Cadence display order: daily → weekly → monthly. */
function cadenceOrder(c: RakebackCadenceId): number {
  return c === "daily" ? 0 : c === "weekly" ? 1 : 2;
}

function cadenceLabel(c: RakebackCadenceId): string {
  return c === "daily" ? "Daily" : c === "weekly" ? "Weekly" : "Monthly";
}

/**
 * Public entry — the cached baseline for a period. `unstable_cache` keyed on the
 * period with a period-aware TTL (60s short windows / 300s lifetime), mirroring
 * the insights-rewards cache discipline.
 */
export async function getSystemEdgeBaseline(
  period: InsightsRewardsPeriod,
): Promise<SystemEdgeBaseline> {
  const cached = unstable_cache(
    () => buildBaseline(period),
    ["system-edge-plan-baseline", period],
    { revalidate: cacheTtlForInsightsPeriod(period) },
  );
  return cached();
}
