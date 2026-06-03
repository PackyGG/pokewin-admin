/**
 * demo-data.ts — DEMO BASELINE GENERATOR.
 *
 * ⚠️  DEMO DATA — illustrative only. Replace with the REAL baseline (fetched
 *     server-side from getDepositBonusOverview / getDepositBonusCapHitRate /
 *     getDepositBonusROI) before trusting any output. See the DEMO-vs-real
 *     table in `constants.ts`.
 *
 * DETERMINISM CONTRACT: this module makes NO wall-clock or RNG calls. No
 * `Date.now()`, no `Math.random()`. All variability comes from a tiny seeded
 * LCG with a FIXED seed, so every render is byte-identical — critical for
 * SSR/CSR hydration parity (a server-rendered demo number must equal the
 * client-rendered one). Calling any export twice returns the same values.
 *
 * Framework-agnostic (no React) — the UI agent imports `buildDemoBaseline()`
 * to seed the sliders and the "DEMO" toggle's baseline.
 */

import {
  DEFAULT_AVG_BONUS_USD,
  DEFAULT_SEGMENT_MIX,
  SEGMENTS,
} from "./constants";
import type { ForecastBaseline, SegmentId } from "./types";

// ─── Seeded LCG (deterministic, no RNG) ──────────────────────────────────────

/**
 * A minimal Lehmer / Park–Miller LCG. Pure function of its state — returns a
 * `next()` closure yielding values in [0,1). Same seed ⇒ same stream, forever.
 * Used ONLY to give the demo series gentle, fixed-shape variation; never for
 * anything that must be unpredictable.
 */
export function seeded(seed: number): () => number {
  // Park–Miller constants; keep state in (0, 2^31−1).
  let state = (Math.floor(seed) % 2147483646) + 1;
  if (state <= 0) state += 2147483646;
  return function next(): number {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** Fixed seed so the demo dataset is identical on every call / render. */
export const DEMO_SEED = 1337;

/** Days of demo daily series produced. */
export const DEMO_DAYS = 30;

// ─── Demo segment cohort ──────────────────────────────────────────────────────

export type DemoSegmentCohort = {
  segment: SegmentId;
  label: string;
  /** Fraction of the demo population in this segment (sums to ~1). */
  share: number;
  /** Demo claimant count in this segment over the demo window. */
  claimants: number;
  /** Demo average bonus (USD) for this segment. */
  avgBonusUsd: number;
};

export type DemoDailyPoint = {
  day: number;
  /** Demo deposits on this day. */
  deposits: number;
  /** Demo bonus claims on this day. */
  claims: number;
  /** Demo bonus volume on this day (USD). */
  volume: number;
};

export type DemoBaseline = {
  /** Per-segment demo cohorts. */
  segments: DemoSegmentCohort[];
  /** 30-day demo deposit/claim/volume series. */
  daily: DemoDailyPoint[];
  /** Aggregate demo baseline shaped exactly like the REAL `ForecastBaseline`. */
  baseline: ForecastBaseline;
};

/** Fixed demo population size (clearly illustrative). */
export const DEMO_ELIGIBLE_POPULATION = 4000;
/** Fixed demo overall claim rate per day (fraction of population). */
const DEMO_DAILY_CLAIM_RATE = 0.085;
/** Fixed demo per-segment avg-bonus multipliers (relative to the base avg). */
const DEMO_SEGMENT_BONUS_MULT: Record<SegmentId, number> = {
  legit_low_risk: 0.85,
  high_value: 2.1,
  promo_sensitive: 1.05,
  high_risk_abuse: 1.45,
  reactivated_dormant: 0.95,
};

/**
 * Build the full deterministic demo baseline. Pure: no clock, no RNG except
 * the fixed-seed LCG. Safe to call during SSR and CSR — identical output.
 */
export function buildDemoBaseline(): DemoBaseline {
  const rand = seeded(DEMO_SEED);

  // ── Daily series (30 days) ──
  const daily: DemoDailyPoint[] = [];
  for (let day = 0; day < DEMO_DAYS; day++) {
    // Gentle ±20% wobble around the mean, fixed by the seed.
    const wobble = 0.8 + rand() * 0.4;
    const deposits = Math.round(DEMO_ELIGIBLE_POPULATION * 0.12 * wobble);
    const claims = Math.round(DEMO_ELIGIBLE_POPULATION * DEMO_DAILY_CLAIM_RATE * wobble);
    const volume = Math.round(claims * DEFAULT_AVG_BONUS_USD * (0.9 + rand() * 0.2) * 100) / 100;
    daily.push({ day, deposits, claims, volume });
  }

  const totalClaims = daily.reduce((a, d) => a + d.claims, 0);
  const totalVolume = Math.round(daily.reduce((a, d) => a + d.volume, 0) * 100) / 100;

  // ── Segment cohorts ──
  const segments: DemoSegmentCohort[] = SEGMENTS.map((seg) => {
    const share = DEFAULT_SEGMENT_MIX[seg.id];
    const claimants = Math.round(totalClaims * share);
    const avgBonusUsd =
      Math.round(DEFAULT_AVG_BONUS_USD * DEMO_SEGMENT_BONUS_MULT[seg.id] * 100) / 100;
    return { segment: seg.id, label: seg.label, share, claimants, avgBonusUsd };
  });

  // Weighted average bonus across the demo cohorts.
  const weightedAvg =
    segments.reduce((a, s) => a + s.avgBonusUsd * s.share, 0) || DEFAULT_AVG_BONUS_USD;

  // Demo empirical cap = a round figure at the baseline; demo cap-hit rate and
  // ROI are fixed illustrative values matching the shape of the real query.
  const baseline: ForecastBaseline = {
    totalCost: totalVolume,
    uniqueClaimants: totalClaims,
    avgBonusUsd: Math.round(weightedAvg * 100) / 100,
    empiricalCapUsd: 100,
    capHitRate: 0.11,
    blendedRoi: 1.8,
    avgGgrPerClaimant: 14.2,
  };

  return { segments, daily, baseline };
}

/**
 * The DEMO baseline as a frozen singleton (computed once, deterministic). Use
 * this when you just need the `ForecastBaseline` shape without the full series.
 */
export const DEMO_BASELINE: ForecastBaseline = buildDemoBaseline().baseline;
