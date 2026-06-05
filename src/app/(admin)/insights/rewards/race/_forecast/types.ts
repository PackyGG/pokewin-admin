/**
 * Serializable models for the RACE-PRIZE forecasting / scenario-simulation
 * engine.
 *
 * Everything here is a PLAIN data shape — no functions, no Decimal objects,
 * no Date instances. Every type round-trips through `JSON.parse(JSON.stringify(x))`
 * unchanged so:
 *   • a server component can pass it as a prop into the `"use client"` island
 *     (Next 15 forbids non-serializable props across the RSC boundary), and
 *   • a scenario can be saved / shared / exported as plain JSON.
 *
 * Mirrors the deposit-bonus reference (`rewards/deposit-bonus/_forecast/types.ts`)
 * exactly: the REWARD-AGNOSTIC result / baseline / recommendation shapes live in
 * the shared engine kit (`insights/_forecast-engine`) and are re-exported here so
 * existing race imports keep working; only the RACE-SPECIFIC shapes (position-
 * tier segment ids, the race-policy discriminated union, the policy-aware
 * Assumptions / ScenarioConfig) live in this file — they extend the generic base
 * types.
 *
 * ── Domain ──────────────────────────────────────────────────────────────────
 * "Races" are on-site competitive wager leaderboards (daily / weekly / monthly).
 * Each race pays a PRIZE POOL out across finishing positions per a tier curve
 * (`race_prize_tiers`). The cost lever surface is therefore: how big the pool is,
 * how the pool is distributed across positions (steepness), how often races run
 * (cadence), and a blunt across-the-board reduction.
 *
 * ── House-POV ───────────────────────────────────────────────────────────────
 * A race prize is a payout the user receives → from the house it is an OUTFLOW
 * (cost → rose). Savings against the house and NGR accretion are GAINS (emerald).
 * "Dead-weight leakage" (prize $ paid to winners who never wager it back) is the
 * race analog of abuse leakage → amber. There is NO inverted convention.
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

// ─── Segments — position tiers ──────────────────────────────────────────────

/**
 * The four finishing-position cohorts the forecast models. These are REAL: the
 * baseline mix is derived from `getRaceInsightsPositions` (the same 1st / 2-3 /
 * 4-10 / 11+ tiering the Positions tab shows, with 11-25 and 26+ folded into a
 * single tail). Stable string IDs so a saved scenario / `Record` keyed by
 * segment stays JSON-serializable.
 *
 * NB: deliberately NOT reusing deposit-bonus's `high_risk_abuse` id — the shared
 * UI special-cases that id with a shield icon, which would mislabel a race tier.
 */
export type SegmentId =
  | "champion" // 1st place — the single largest prize per race
  | "podium" // positions 2-3 — the rest of the top of the board
  | "mid" // positions 4-10 — the middle of the prize curve
  | "tail"; // positions 11+ — the long tail of small prizes

// ─── Race-policy rules (discriminated union) ────────────────────────────────

/** Discriminant tag for {@link RacePolicy}. */
export type RacePolicyKind =
  | "flat_pool"
  | "scaled_pool"
  | "steepness"
  | "cadence"
  | "reduction";

/**
 * A race PRIZE-POOL policy. Discriminated on `kind` so a scenario can be
 * persisted / shared as plain JSON and exhaustively matched in the engine.
 *
 *  • flat_pool   — the current baseline: the real per-race pool at the current
 *                  cadence + the current (real, baseline) tier curve. Every other
 *                  scenario is measured against this. `poolScale` / `cadenceMult`
 *                  are 1, steepness is the baseline.
 *  • scaled_pool — the SAME tier curve + cadence, but the whole pool scaled by
 *                  `poolScale` (e.g. 0.6× = 40% smaller pools, 1.4× = richer).
 *                  The cleanest "how much should we spend" lever.
 *  • steepness   — REDISTRIBUTE the same total pool along the position curve.
 *                  `steepness` ∈ (0,2): 1 = baseline curve, >1 = MORE top-heavy
 *                  (champion takes a bigger share, tail shrinks), <1 = flatter
 *                  (spread toward the tail). Cost-neutral on the pool but moves
 *                  retention/leakage (top-heavy concentrates spend on a few big
 *                  winners; flat spreads engagement across more players).
 *  • cadence     — change how OFTEN races run via `cadenceMult` (e.g. 0.5× =
 *                  half as many races, 2× = twice as many). Total cost scales
 *                  with the race count; per-race pool + curve unchanged.
 *  • reduction   — a blunt across-the-board `reductionPct` (0-1) trimmed off
 *                  EVERY prize, same curve + cadence. The simplest cost cut.
 */
export type RacePolicy =
  | { kind: "flat_pool" }
  | { kind: "scaled_pool"; poolScale: number }
  | { kind: "steepness"; steepness: number }
  | { kind: "cadence"; cadenceMult: number }
  | { kind: "reduction"; reductionPct: number };

// ─── Scenario config ────────────────────────────────────────────────────────

/**
 * A complete, shareable race scenario definition. Extends the generic
 * {@link BaseScenarioConfig} (id / label / description / schemaVersion) with the
 * race-specific `policy`. `schemaVersion` is pinned so saved/exported scenarios
 * can be migrated forward without ambiguity.
 */
export type ScenarioConfig = BaseScenarioConfig & {
  policy: RacePolicy;
};

// ─── Assumptions (the tunable levers) ───────────────────────────────────────

/**
 * Every behavioural / volume / structural assumption the engine multiplies by.
 * Extends the generic {@link BaseAssumptions} (the reward-agnostic volume + claim
 * levers the shared orchestration reads) with the race-SPECIFIC levers. In the UI
 * each is a slider seeded from a `DEFAULT_*` constant (or a real measured value).
 *
 * Rates / multipliers / shares — never raw money except `avgBonusUsd` (the avg
 * prize per winner). The engine normalizes / clamps everything defensively, but
 * callers should keep fractions in [0,1].
 *
 * VOLUME is anchored to the REAL measured winner count (no synthetic
 * population): `baselineClaimants` over `baselinePeriodDays` is scaled to the
 * forecast horizon and modulated by the claim-probability lever relative to its
 * REAL measured default (`baselineClaimProbability`). See {@link ForecastBaseline}.
 */
export type Assumptions = BaseAssumptions & {
  /** Fractional split of winners across position tiers — engine normalizes to sum 1. */
  segmentMix: Record<SegmentId, number>;
  /**
   * Global pool-size multiplier applied on TOP of each scenario's policy
   * (1 = as-is). A what-if "what if every pool were X% bigger/smaller" knob that
   * stacks with the structural scenario. 0-3.
   */
  prizePoolMultiplier: number;
  /**
   * Tier steepness multiplier applied on top of the scenario (1 = baseline
   * curve, >1 = more top-heavy, <1 = flatter). Lets the admin sweep the
   * distribution shape independent of which structural scenario is selected.
   */
  tierSteepness: number;
  /**
   * Race-cadence multiplier applied on top of the scenario (1 = current
   * frequency). Scales the modeled race count → total cost. 0-3.
   */
  raceCadenceMultiplier: number;
  /**
   * Share of prize $ that is DEAD-WEIGHT at the baseline — paid to winners who
   * never wager it back (one-off / churned winners), 0-1. The race analog of
   * abuse leakage. A steeper / smaller-pool policy reduces it (less spend on
   * non-engaging tail winners).
   */
  deadweightShare: number;
  /**
   * How strongly a steeper / tighter pool suppresses dead-weight leakage, 0-1
   * (1 = fully elastic). Higher → restructuring kills more leakage.
   */
  leakageCaptureElasticity: number;
  /** Incremental retained downstream wager revenue per $1 of prize to engaged winners. */
  retentionUplift: number;
  /** Share of prize paid to players who'd have wagered anyway, 0-1 (cannibalization). */
  cannibalizationRate: number;
  /**
   * Engagement (participation) lost per unit of pool shrink, 0-1. Tighter pools
   * sap the competitive incentive → fewer entrants → some retained revenue given
   * up, so net savings < gross.
   */
  engagementSensitivity: number;
};
