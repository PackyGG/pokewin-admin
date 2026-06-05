/**
 * live-policy.ts — derive the affiliate forecast's REAL per-tier baseline rates
 * + the baseline/what-if scenarios from the live `affiliate_level_configs`
 * commission ladder, instead of the fabricated `BASELINE_TIER_RATE`
 * (whale 8% / established 6% / …) placeholders.
 *
 * WHY this exists
 * ───────────────
 * The forecast modeled a guessed 5-tier rate map + a flat 5% blended reference.
 * The real commission ladder is 8 levels (`affiliate_level_configs`,
 * `commission_rate` + `threshold` per level), fetched read-only at request time
 * via `getAffiliateLevelConfigs()`. The fix: collapse the real ladder onto the 5
 * modeled tiers, anchor the engine's per-tier baseline rates + blended reference
 * to those REAL rates, and make the baseline + what-if scenarios reflect the
 * real ladder (not a placeholder).
 *
 * HOW it threads the real config (read-only, request-time)
 * ────────────────────────────────────────────────────────
 * The server tab fetches `getAffiliateLevelConfigs()` and attaches the rows onto
 * the `ForecastBaseline` via the `levelConfigs` extension field (plain props
 * survive the RSC boundary). `affiliateBaselineTierRate(baseline)` collapses
 * them onto the 5 tiers; the config's `defaults` seeds the engine's
 * `baselineTierRate` / `baselineBlendedRate` from that, and
 * `buildAffiliateScenarios(baseline)` builds the live scenario library.
 *
 * Everything here is PURE + serializable.
 */

import type { ForecastBaseline } from "../../../_forecast-engine";
import { BASELINE_BLENDED_RATE, BASELINE_TIER_RATE, DEFAULT_TIER_MIX, TIERS } from "./constants";
import type { ScenarioConfig, TierId } from "./types";

/** One real `affiliate_level_configs` row, narrowed to what the forecast needs. */
export type AffiliateLevelConfig = {
  /** Ladder level (1 … N). */
  level: number;
  /** Display label (e.g. "Level 5"). */
  label: string;
  /** Commission rate as a decimal fraction (e.g. 0.05 = 5%). */
  commissionRate: number;
  /** Cumulative referred-wager threshold to reach this level (USD). */
  threshold: number;
};

/**
 * The affiliate real-config extension field the server tab attaches onto the
 * `ForecastBaseline` — the live commission ladder this module reads.
 */
export type AffiliateBaselineExt = ForecastBaseline & {
  levelConfigs?: AffiliateLevelConfig[];
};

const NEUTRAL_TIER_MULT: Record<TierId, number> = {
  whale: 1,
  established: 1,
  emerging: 1,
  micro: 1,
  dormant: 1,
};

/** Average a list of numbers (0 when empty). */
function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Collapse the real `affiliate_level_configs` ladder onto the 5 modeled tiers
 * (whale → dormant) by commission rate. The ladder is sorted ascending by rate
 * and split into bands: the TOP band → whale, the next → established, the
 * middle → emerging, the bottom band → micro, and dormant takes the entry-level
 * rate (historically-qualified affiliates contributing ~no recent wager earn at
 * the lowest configured rate).
 *
 * Returns `null` when the ladder is empty (caller falls back to the static
 * placeholder map).
 */
export function affiliateBaselineTierRate(
  configs: AffiliateLevelConfig[],
): Record<TierId, number> | null {
  const rates = configs
    .map((c) => Math.max(0, c.commissionRate))
    .filter((r) => Number.isFinite(r))
    .sort((a, b) => a - b);
  if (rates.length === 0) return null;

  // Lowest configured rate = the entry / dormant rate.
  const entry = rates[0];
  // Highest configured rate = the whale rate.
  const top = rates[rates.length - 1];

  if (rates.length === 1) {
    // A degenerate single-rate ladder → every tier shares it.
    return { whale: top, established: top, emerging: top, micro: top, dormant: entry };
  }

  // Split the sorted rates into 4 contiguous bands (micro → whale) and average
  // each band so the modeled tier rate is representative of the levels in it.
  const n = rates.length;
  const bandOf = (lo: number, hi: number) => rates.slice(lo, hi);
  // Quartile cut points (at least 1 level per band when n ≥ 4; overlaps fold
  // gracefully for small ladders via avg()).
  const q1 = Math.max(1, Math.round(n * 0.25));
  const q2 = Math.max(q1 + 1, Math.round(n * 0.5));
  const q3 = Math.max(q2 + 1, Math.round(n * 0.75));

  const microRate = avg(bandOf(0, q1)) || entry;
  const emergingRate = avg(bandOf(q1, q2)) || microRate;
  const establishedRate = avg(bandOf(q2, q3)) || emergingRate;
  const whaleRate = avg(bandOf(q3, n)) || top;

  return {
    whale: whaleRate,
    established: establishedRate,
    emerging: emergingRate,
    micro: microRate,
    // Dormant affiliates earn at the entry rate (lowest configured).
    dormant: entry,
  };
}

/**
 * The REAL blended commission rate = the tier-mix-weighted average of the
 * collapsed per-tier rates (consistent with how the engine's `blendedRate`
 * computes a policy's blended rate). This is the reference the rate-cut /
 * cannibalization math compares against. Uses the default tier mix as the
 * weighting (the same mix the engine seeds).
 */
export function affiliateBaselineBlendedRate(tierRate: Record<TierId, number>): number {
  let sum = 0;
  let weight = 0;
  for (const t of TIERS) {
    const w = Math.max(0, DEFAULT_TIER_MIX[t.id] ?? 0);
    sum += Math.max(0, tierRate[t.id] ?? 0) * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}

/** Format a 0-1 rate fraction as a percent string, e.g. 0.05 → "5%". */
function pct(rate: number): string {
  const v = rate * 100;
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return `${s}%`;
}

/** Format a USD threshold compactly, e.g. 1500000 → "$1.5M". */
function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

/**
 * A short "real baseline" note for the KPI strip: the real ladder span, e.g.
 * "8-level ladder · 3%→10% · ~5% blended". Falls back to a generic blended-%
 * note when no real ladder was threaded.
 */
export function affiliateBaselineNote(baseline: ForecastBaseline): string {
  const ext = baseline as AffiliateBaselineExt;
  const cfgs = ext.levelConfigs ?? [];
  if (cfgs.length === 0) return `~${pct(BASELINE_BLENDED_RATE)} blended`;
  const rates = cfgs.map((c) => c.commissionRate).filter((r) => Number.isFinite(r));
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  const tierRate = affiliateBaselineTierRate(cfgs);
  const blended = tierRate ? affiliateBaselineBlendedRate(tierRate) : BASELINE_BLENDED_RATE;
  return `${cfgs.length}-level ladder · ${pct(lo)}→${pct(hi)} · ~${pct(blended)} blended`;
}

// ─── Scenario builder ─────────────────────────────────────────────────────────

const SCHEMA = 1 as const;

/**
 * Build the LIVE affiliate scenario library from the real commission ladder on
 * the baseline. Returns `null` when no real ladder was threaded (the caller
 * falls back to the static library).
 *
 * Scenarios (all measured against the REAL ladder, which the engine's per-tier
 * baseline rates are anchored to via `defaults`):
 *   • Current        — the live ladder (rates as configured). The reference.
 *   • Flat trims     — every rate −10% / −20% / −30% across the board.
 *   • Squeeze whales — cut the richest top levels hard, protect the funnel.
 *   • Trim the tail  — cut the low-ROI entry/dormant rates, keep top partners.
 *   • 1× wager req.  — a HYPOTHETICAL anti-abuse what-if: require referred users
 *                      to wager 1× their deposit before commission accrues,
 *                      modeled as a referral-quality screen that filters churned
 *                      / no-wager traffic out of the commission base. Clearly
 *                      labeled as a what-if (not a current config).
 */
export function buildAffiliateScenarios(
  baseline: ForecastBaseline,
): { scenarios: ScenarioConfig[]; whatifSet: ScenarioConfig[]; baselineScenarioId: string } | null {
  const ext = baseline as AffiliateBaselineExt;
  const cfgs = ext.levelConfigs;
  if (!cfgs || cfgs.length === 0) return null;

  const tierRate = affiliateBaselineTierRate(cfgs);
  if (!tierRate) return null;

  const rates = cfgs.map((c) => c.commissionRate).filter((r) => Number.isFinite(r));
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  const sorted = [...cfgs].sort((a, b) => a.commissionRate - b.commissionRate);
  const topLevel = sorted[sorted.length - 1];
  const ladderSpan = `${cfgs.length}-level ladder, ${pct(lo)}→${pct(hi)}`;

  // ── A · Current — the REAL ladder ──
  const baselineScenario: ScenarioConfig = {
    id: "A-current",
    label: "A · Current ladder",
    description: `The live commission ladder: ${ladderSpan} (top level "${topLevel.label}" at ${pct(topLevel.commissionRate)} above ${usd(topLevel.threshold)} referred wager). The reference every other scenario is measured against — savings vs baseline = 0; cost anchors to the real total.`,
    policy: { kind: "current" },
    schemaVersion: SCHEMA,
  };

  const scenarios: ScenarioConfig[] = [baselineScenario];
  const whatifSet: ScenarioConfig[] = [baselineScenario];

  // ── B · Flat trims −10% / −20% / −30% (against the REAL rates) ──
  for (const [label, mult] of [
    ["−10%", 0.9],
    ["−20%", 0.8],
    ["−30%", 0.7],
  ] as const) {
    const sc: ScenarioConfig = {
      id: `B-trim-${Math.round((1 - mult) * 100)}`,
      label: `B · ${label} flat`,
      description: `Every level's commission rate cut ${label} across the real ladder (${pct(lo)}→${pct(hi)} becomes ${pct(lo * mult)}→${pct(hi * mult)}). A uniform trim — shaves the bill proportionally with predictable partner friction.`,
      policy: { kind: "flat_trim", rateMult: mult },
      schemaVersion: SCHEMA,
    };
    scenarios.push(sc);
    whatifSet.push(sc);
  }

  // ── C · Squeeze whales — cut the top of the real ladder hard ──
  scenarios.push({
    id: "C-squeeze-whales",
    label: "C · Squeeze top levels",
    description: `Cut the richest levels hard (whale −30%, established −20%) while leaving the emerging/micro entry rates intact and trimming the dormant tail. Targets the bulk of the bill where the top affiliates are least price-sensitive, protecting the acquisition funnel.`,
    policy: {
      kind: "per_tier",
      perTierRateMult: { ...NEUTRAL_TIER_MULT, whale: 0.7, established: 0.8, dormant: 0.8 },
    },
    schemaVersion: SCHEMA,
  });

  // ── C · Trim the tail — cut the low-ROI entry/dormant rates ──
  scenarios.push({
    id: "C-trim-tail",
    label: "C · Trim the tail",
    description: `Keep the top levels whole, trim emerging (−15%) and cut the micro/dormant entry rates hard (−40% / −60%). Squeezes the low-ROI long tail of small affiliates while keeping top partners' rates intact.`,
    policy: {
      kind: "per_tier",
      perTierRateMult: { ...NEUTRAL_TIER_MULT, emerging: 0.85, micro: 0.6, dormant: 0.4 },
    },
    schemaVersion: SCHEMA,
  });

  // ── D · 1× wager requirement (hypothetical anti-abuse what-if) ──
  // NOT a current config — a modeled policy: referred users must wager 1× their
  // deposit before commission accrues, which filters churned / no-wager traffic
  // out of the commission base. Modeled via the hybrid policy's referral-quality
  // SCREEN (rates unchanged, threshold unchanged) — the cleanest representation
  // of "screen junk wager out of the base" the engine already supports.
  const oneXScreen: ScenarioConfig = {
    id: "D-wager-req-1x",
    label: "D · 1× wager requirement",
    description: `What-if (not a current setting): require a referred user to wager 1× their deposit before commission accrues. Modeled as a 35% referral-quality screen that filters churned / no-wager traffic out of the commission base — rates unchanged. Cuts leakage on low-quality referrals; adds some affiliate friction (delayed payouts).`,
    policy: {
      kind: "hybrid",
      perTierRateMult: { ...NEUTRAL_TIER_MULT },
      thresholdMult: 1,
      qualityScreen: 0.35,
    },
    schemaVersion: SCHEMA,
  };
  scenarios.push(oneXScreen);
  whatifSet.push(oneXScreen);

  // ── D · 1× wager req. + −15% — stack the screen on a uniform rate trim ──
  scenarios.push({
    id: "D-wager-req-1x-trim",
    label: "D · 1× wager req + −15%",
    description: `Stack the 1× wager-requirement screen (35% of low-quality wager filtered out) on top of a uniform −15% rate trim across the real ladder. Squeezes both leakage and the bill, at compounding affiliate friction.`,
    policy: {
      kind: "hybrid",
      perTierRateMult: {
        whale: 0.85,
        established: 0.85,
        emerging: 0.85,
        micro: 0.85,
        dormant: 0.85,
      },
      thresholdMult: 1,
      qualityScreen: 0.35,
    },
    schemaVersion: SCHEMA,
  });

  return { scenarios, whatifSet, baselineScenarioId: baselineScenario.id };
}
