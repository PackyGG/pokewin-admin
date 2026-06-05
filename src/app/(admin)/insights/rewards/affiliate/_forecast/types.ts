/**
 * Serializable models for the AFFILIATE commission forecasting / scenario-
 * simulation engine.
 *
 * Everything here is a PLAIN data shape — no functions, no Decimal objects,
 * no Date instances. Every type round-trips through `JSON.parse(JSON.stringify(x))`
 * unchanged so:
 *   • a server component can pass it as a prop into the `"use client"` island
 *     (Next 15 forbids non-serializable props across the RSC boundary), and
 *   • a scenario can be saved / shared / exported as plain JSON.
 *
 * This mirrors the deposit-bonus reference (`rewards/deposit-bonus/_forecast/
 * types.ts`): the REWARD-AGNOSTIC result / baseline / recommendation shapes live
 * in the shared engine kit (`insights/_forecast-engine`) and are re-exported
 * here so the standard imports keep working; only the AFFILIATE-SPECIFIC shapes
 * (tier segment ids, the commission-rate `RatePolicy`, the rate-aware Assumptions
 * / ScenarioConfig) live in this file and extend the generic base types.
 *
 * ── What this reward models ──────────────────────────────────────────────────
 * The affiliate program pays `affiliate_claim` ledger commission as a % of the
 * referred cohort's downstream wager. Unlike the deposit-bonus reward (where the
 * policy axis is a CAP), the affiliate policy axis is the COMMISSION RATE LADDER
 * (`affiliate_level_configs.commission_rate`) and the QUALIFICATION THRESHOLD
 * ladder. A scenario therefore either trims the rates uniformly, overrides them
 * per tier, tightens the qualification thresholds, or does a combination.
 *
 * House-POV (CLAUDE.md, strict): commission PAID is a house OUTFLOW (rose).
 * SAVINGS against the house (a lower commission bill) and NGR accretion are house
 * GAINS (emerald). Abuse leakage (commission paid on low-quality / churned
 * referral traffic) is amber.
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

// ─── Segments — the affiliate tiers ─────────────────────────────────────────

/**
 * The affiliate population modeled as four cumulative-wager TIERS plus a dormant
 * cohort. These map onto the real `affiliate_level_configs` ladder collapsed to
 * four representative bands (the live ladder has 8 levels; modeling every level
 * as its own scenario lever would be noise — four bands capture the economics:
 * whales drive most of the commission bill, the long tail barely moves it).
 *
 *  • whale          — top-band affiliates: the largest referred cohorts, the
 *                     bulk of the commission bill and the downstream wager.
 *  • established    — mid-high band: steady, qualified affiliates.
 *  • emerging       — low band: recently-qualified affiliates building volume.
 *  • micro          — just over the qualification threshold; smallest cohorts.
 *  • dormant        — qualified historically but contributing ~no recent wager
 *                     (commission accrual ≈ 0; sensitive to a threshold tighten).
 *
 * Stable string ids so a saved scenario / `Record` keyed by tier stays JSON-
 * serializable.
 */
export type TierId =
  | "whale"
  | "established"
  | "emerging"
  | "micro"
  | "dormant";

// ─── Rate policy (discriminated union) ──────────────────────────────────────

/** Discriminant tag for {@link RatePolicy}. */
export type RatePolicyKind =
  | "current"
  | "flat_trim"
  | "per_tier"
  | "qualification"
  | "hybrid";

/**
 * An affiliate commission policy. Discriminated on `kind` so a scenario can be
 * persisted / shared as plain JSON and exhaustively matched in the engine.
 *
 *  • current        — the live policy: per-tier commission rates as configured,
 *                     current qualification thresholds. The reference every other
 *                     scenario is measured against (savings vs baseline = 0).
 *  • flat_trim      — every tier's commission rate multiplied by `rateMult` (<1
 *                     = a uniform across-the-board trim, e.g. 0.8 = −20%). The
 *                     simplest lever: shave the whole bill proportionally.
 *  • per_tier       — explicit per-tier commission-rate MULTIPLIERS, so a policy
 *                     can shave whale rates hard while leaving emerging/micro
 *                     untouched (protect the acquisition funnel, squeeze the
 *                     top). 1 = unchanged, <1 = trim, >1 = richer.
 *  • qualification  — RAISE the cumulative-wager qualification threshold by
 *                     `thresholdMult` (>1 = a higher bar). Affiliates below the
 *                     new bar stop accruing — kills the long-tail / dormant
 *                     commission AND loses the referral volume they brought.
 *                     `rateMult` optionally trims rates on top (1 = rates kept).
 *  • hybrid         — the balanced policy: per-tier rate multipliers + a
 *                     qualification tighten + a referral-quality screen
 *                     (`qualityScreen`, the fraction of low-quality referral
 *                     wager filtered out of the commission base). The most
 *                     moving parts.
 */
export type RatePolicy =
  | { kind: "current" }
  | { kind: "flat_trim"; rateMult: number }
  | { kind: "per_tier"; perTierRateMult: Record<TierId, number> }
  | { kind: "qualification"; thresholdMult: number; rateMult: number }
  | {
      kind: "hybrid";
      perTierRateMult: Record<TierId, number>;
      /** Qualification-threshold multiplier (>1 = higher bar). */
      thresholdMult: number;
      /** Fraction (0-1) of low-quality referral wager screened OUT of the base. */
      qualityScreen: number;
    };

// ─── Scenario config ────────────────────────────────────────────────────────

/**
 * A complete, shareable scenario definition. Extends the generic
 * {@link BaseScenarioConfig} (id / label / description / schemaVersion) with the
 * affiliate-specific `policy`. `schemaVersion` is pinned so saved/exported
 * scenarios can be migrated forward without ambiguity.
 */
export type ScenarioConfig = BaseScenarioConfig & {
  policy: RatePolicy;
};

// ─── Assumptions (the tunable levers) ───────────────────────────────────────

/**
 * Every behavioural / volume assumption the engine multiplies by. Extends the
 * generic {@link BaseAssumptions} (the reward-agnostic volume + claim levers the
 * shared orchestration reads) with the affiliate-SPECIFIC behavioural levers.
 * In the UI each is a slider seeded from a `DEFAULT_*` constant (or the real
 * baseline, for the data anchors).
 *
 * Rates / probabilities / multipliers — never raw money except `avgBonusUsd`
 * (here: the real avg commission per active affiliate over the window). The
 * engine normalizes / clamps everything defensively, but callers should keep
 * fractions in [0,1].
 *
 * VOLUME is anchored to the REAL measured active-affiliate count (no synthetic
 * population): `baselineClaimants` over `baselinePeriodDays` is scaled to the
 * forecast horizon and modulated by the claim-probability lever relative to its
 * REAL measured default (`baselineClaimProbability`). See {@link ForecastBaseline}.
 */
export type Assumptions = BaseAssumptions & {
  /** Fractional split across tiers — engine normalizes to sum 1. */
  tierMix: Record<TierId, number>;
  /**
   * Per-tier BASELINE commission rate ($ per $1 referred wager), collapsed from
   * the REAL `affiliate_level_configs` ladder onto the 5 modeled tiers. Every
   * policy's per-tier rate is computed RELATIVE to these. Optional: the engine
   * falls back to the static `BASELINE_TIER_RATE` placeholder when absent (the
   * self-check harness / a malformed shared link); the live page always sets the
   * real values.
   */
  baselineTierRate?: Record<TierId, number>;
  /**
   * The REAL blended commission rate (the tier-mix-weighted average of
   * `baselineTierRate`) — the reference `rateCutSeverity` / cannibalization math
   * compares a policy's blended rate against. Optional; falls back to the static
   * `BASELINE_BLENDED_RATE` placeholder when absent.
   */
  baselineBlendedRate?: number;
  /**
   * Global commission-rate scaler applied on TOP of any scenario policy, 0-2.
   * 1 = the configured/scenario rates as-is; <1 trims, >1 enriches. The "what
   * if we shaved every rate by X%" master lever, independent of the per-scenario
   * policy shape.
   */
  commissionRateMult: number;
  /**
   * Referral QUALITY, 0-1 — the share of attributed referral wager that is
   * genuine (engaged, retained) rather than churned / self-referred / low-value.
   * Drives how much downstream GGR the commission actually buys (retention base)
   * and how much of the commission is "leakage" paid on junk traffic.
   */
  referralQuality: number;
  /**
   * How strongly a qualification tighten (higher threshold) suppresses
   * low-quality / dormant commission, 0-1 (1 = fully elastic). Higher → raising
   * the bar kills more leakage.
   */
  qualificationElasticity: number;
  /** Incremental retained house revenue per $1 of commission paid to a quality cohort. */
  retentionUplift: number;
  /**
   * Share of commission paid on referral traffic that would have signed up
   * ANYWAY (organic, brand search) — pure cannibalization, 0-1.
   */
  cannibalizationRate: number;
  /**
   * Referred-volume lost per unit of qualification tightening, 0-1. Raising the
   * bar deters marginal affiliates from promoting → fewer real referrals. Higher
   * → a threshold tighten sacrifices more genuine acquisition → net savings <
   * gross.
   */
  acquisitionSensitivity: number;
};
