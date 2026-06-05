/**
 * Serializable models for the deposit-bonus forecasting / scenario-simulation
 * engine.
 *
 * Everything here is a PLAIN data shape — no functions, no Decimal objects,
 * no Date instances. Every type round-trips through `JSON.parse(JSON.stringify(x))`
 * unchanged so:
 *   • a server component can pass it as a prop into the `"use client"` island
 *     (Next 15 forbids non-serializable props across the RSC boundary), and
 *   • a scenario can be saved / shared / exported as plain JSON.
 *
 * This mirrors the edge-calc idiom (`insights/edge-calc/types.ts` +
 * `math.ts`): pure primitive in, pure primitive out, dep-free, framework-
 * agnostic, so the same engine the UI calls in `useMemo` could be called by a
 * future server-side validator or export with zero changes.
 *
 * ── Shared foundation ───────────────────────────────────────────────────────
 * The REWARD-AGNOSTIC result / baseline / recommendation shapes now live in the
 * shared engine kit (`insights/_forecast-engine`) and are re-exported here so
 * existing deposit-bonus imports keep working unchanged. Only the deposit-bonus
 * SPECIFIC shapes (segment ids, cap rules, the cap-aware Assumptions /
 * ScenarioConfig) live in this file — they extend the generic base types.
 */

// ─── Re-exported generic shapes (the shared foundation) ─────────────────────

export type {
  DailyPoint,
  ForecastBaseline,
  PerSegment,
  Recommendation,
  RecommendationBadge,
  SimulationResult,
} from "../../../_forecast-engine";

import type { BaseAssumptions, BaseScenarioConfig } from "../../../_forecast-engine";

// ─── Segments ─────────────────────────────────────────────────────────────

/**
 * The five behavioural cohorts the forecast models. Each scenario distributes
 * eligible users across these and applies segment-specific cap / abuse /
 * retention dynamics. Stable string IDs so a saved scenario / `Record` keyed
 * by segment stays JSON-serializable.
 */
export type SegmentId =
  | "legit_low_risk"
  | "high_value"
  | "promo_sensitive"
  | "high_risk_abuse"
  | "reactivated_dormant";

// ─── Cap rules (discriminated union) ───────────────────────────────────────

/** Discriminant tag for {@link CapRule}. */
export type CapKind =
  | "fixed_window"
  | "split_window"
  | "weekly_pooled"
  | "progressive_decay"
  | "dynamic_segment";

/**
 * A deposit-bonus cap policy. Discriminated on `kind` so a scenario can be
 * persisted / shared as plain JSON and exhaustively matched in the engine.
 *
 *  • fixed_window     — one flat cap per rolling window (the current baseline:
 *                       $100 / 24h).
 *  • split_window     — the same flat cap but enforced over a SHORTER window
 *                       (e.g. $10 / 1h, $20 / 6h, $50 / 12h). More frequent,
 *                       smaller tranches — paces payouts, dampens bursts.
 *  • weekly_pooled    — a single pooled cap across a 7-day period (amortized
 *                       to the modeled window by the engine).
 *  • progressive_decay— a base cap that decays by `decayPerClaim` after each
 *                       claim, floored at `floorCapUsd` — throttles serial
 *                       claimers while staying generous to first claims.
 *  • dynamic_segment  — per-segment caps (low-risk high, high-risk low), a
 *                       first-deposit-of-day multiplier rewarding genuine
 *                       re-deposits, and a decay-after-N throttle on serial
 *                       claimers. The "hybrid" policy.
 */
export type CapRule =
  | { kind: "fixed_window"; capUsd: number; windowHours: number }
  | { kind: "split_window"; capUsd: number; windowHours: number }
  | { kind: "weekly_pooled"; capUsd: number }
  | {
      kind: "progressive_decay";
      baseCapUsd: number;
      windowHours: number;
      /** Fraction (0-1) of the base cap removed per prior claim. */
      decayPerClaim: number;
      /** Lower bound the decayed cap never falls below. */
      floorCapUsd: number;
    }
  | {
      kind: "dynamic_segment";
      perSegmentCapUsd: Record<SegmentId, number>;
      windowHours: number;
      /** Multiplier (>1 = more generous) applied to the first deposit of the day. */
      firstDepositOfDayBonusMult: number;
      /** Decay kicks in after this many claims. */
      decayAfterNClaims: number;
      /** Fraction (0-1) of the cap removed per claim beyond the threshold. */
      decayPerClaim: number;
    };

// ─── Scenario config ────────────────────────────────────────────────────────

/**
 * A complete, shareable scenario definition. Extends the generic
 * {@link BaseScenarioConfig} (id / label / description / schemaVersion) with the
 * deposit-bonus-specific `cap` policy. `schemaVersion` is pinned so
 * saved/exported scenarios can be migrated forward without ambiguity.
 */
export type ScenarioConfig = BaseScenarioConfig & {
  cap: CapRule;
};

// ─── Assumptions (the tunable levers) ───────────────────────────────────────

/**
 * Every behavioural / volume assumption the engine multiplies by. Extends the
 * generic {@link BaseAssumptions} (the reward-agnostic volume + claim levers the
 * shared orchestration reads) with the deposit-bonus-SPECIFIC behavioural
 * levers. In the UI each is a slider seeded from a `DEFAULT_*` constant.
 *
 * Rates / probabilities / multipliers — never raw money except `avgBonusUsd`.
 * The engine normalizes / clamps everything defensively, but callers should
 * keep fractions in [0,1].
 *
 * VOLUME is anchored to the REAL measured claimant count (no synthetic
 * population): `baselineClaimants` over `baselinePeriodDays` is scaled to the
 * forecast horizon and modulated by the claim-probability lever relative to its
 * REAL measured default (`baselineClaimProbability`). See {@link ForecastBaseline}.
 */
export type Assumptions = BaseAssumptions & {
  /** Fractional split across segments — engine normalizes to sum 1. */
  segmentMix: Record<SegmentId, number>;
  /** Share of awarded bonus never wagered (expired / unused), 0-1. */
  breakageRate: number;
  /** Share of claimants behaving abusively at the BASELINE cap, 0-1. */
  abuseShare: number;
  /** How strongly stricter caps suppress abuse, 0-1 (1 = fully elastic). */
  abuseCaptureElasticity: number;
  /** Incremental retained revenue per $1 of bonus paid to legit users. */
  retentionUplift: number;
  /** Share of bonus paid to users who'd have deposited anyway, 0-1. */
  cannibalizationRate: number;
  /** Legit conversion lost per unit of cap tightening, 0-1. */
  legitConversionSensitivity: number;
};
