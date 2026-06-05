/**
 * Serializable models for the RAKEBACK forecasting / scenario-simulation engine.
 *
 * Everything here is a PLAIN data shape — no functions, no Decimal objects, no
 * Date instances. Every type round-trips through `JSON.parse(JSON.stringify(x))`
 * unchanged so:
 *   • a server component can pass it as a prop into the `"use client"` island
 *     (Next 15 forbids non-serializable props across the RSC boundary), and
 *   • a scenario can be saved / shared / exported as plain JSON.
 *
 * This mirrors the deposit-bonus reference (`rewards/deposit-bonus/_forecast/
 * types.ts`): pure primitive in, pure primitive out, dep-free, framework-
 * agnostic, so the same engine the UI calls in `useMemo` could be called by a
 * future server-side validator or export with zero changes.
 *
 * ── Shared foundation ───────────────────────────────────────────────────────
 * The REWARD-AGNOSTIC result / baseline / recommendation shapes live in the
 * shared engine kit (`insights/_forecast-engine`) and are re-exported here so
 * the rakeback config + components import everything from one barrel. Only the
 * rakeback-SPECIFIC shapes (the wager-tier segment ids, the rate-policy rule,
 * the rate-aware Assumptions / ScenarioConfig) live in this file — they extend
 * the generic base types.
 *
 * ── Rakeback ≠ deposit-bonus ────────────────────────────────────────────────
 * Deposit-bonus's policy lever is a CAP (a $ ceiling per time window). Rakeback
 * has no cap — it is a RATE: a % of a user's wager rebated back. So the policy
 * axis here is the rakeback RATE (and its cadence / expiry / tiering), not a
 * dollar cap. The cost model is `wager × effectiveRate × (1 − breakage)`, not a
 * truncated-distribution-under-a-cap. Everything else (real-baseline anchoring,
 * per-segment breakdown, House-POV money, the shared UI island) is identical.
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
 * The four behavioural cohorts the rakeback forecast models, partitioned by
 * WAGER VOLUME (the variable rakeback is computed against). Each scenario
 * distributes claimant wager across these and applies tier-specific rate /
 * retention / churn dynamics. Stable string IDs so a saved scenario / `Record`
 * keyed by segment stays JSON-serializable.
 *
 *  • whales       — the highest-wager cohort. Most of the rakeback DOLLARS flow
 *                   here (rakeback is wager-proportional), so their rate is the
 *                   single biggest cost lever; they also generate the most
 *                   downstream GGR, so over-trimming their rate risks retention.
 *  • mid_volume   — the engaged mid-stakes core. Rakeback is a meaningful
 *                   retention tool here; moderate downstream value.
 *  • low_volume   — casual / low-stakes players. Small per-user rakeback, thin
 *                   downstream value; the cohort most exposed to rate trims.
 *  • dormant      — reactivated / sporadic players. Rakeback can nudge a return,
 *                   but a slice is wager farmed purely to harvest the rebate
 *                   (the leakage channel) with little real play behind it.
 */
export type SegmentId = "whales" | "mid_volume" | "low_volume" | "dormant";

// ─── Rate-policy rule (discriminated union) ────────────────────────────────

/** Discriminant tag for {@link RatePolicy}. */
export type RatePolicyKind =
  | "flat_rate"
  | "tiered_by_wager"
  | "cadence_gated"
  | "expiry_capped"
  | "progressive_taper";

/**
 * The claim-cadence a rakeback policy enforces — how often a user can sweep
 * their accrued rebate. A serializable string enum so a scenario persists as
 * plain JSON. Faster cadence (daily) → users claim more reliably → LESS
 * breakage (less expires unclaimed). Slower cadence (monthly) → more accrues,
 * but more lapses before a claim → MORE breakage. Drives the realized-cost
 * fraction, NOT the gross accrued rate.
 */
export type ClaimCadence = "daily" | "weekly" | "monthly";

/**
 * A rakeback rate policy. Discriminated on `kind` so a scenario can be
 * persisted / shared as plain JSON and exhaustively matched in the engine. The
 * `rate` figures are FRACTIONS of wager (0.05 = 5% of wager rebated), never
 * dollars.
 *
 *  • flat_rate        — one flat % of wager for everyone (the current baseline),
 *                       on a fixed claim cadence.
 *  • tiered_by_wager  — per-segment % (whales low, low-volume high), the
 *                       canonical "reward small players, taper big ones"
 *                       rakeback shape. The hybrid policy.
 *  • cadence_gated    — a flat % but on a SPECIFIED cadence (daily / weekly /
 *                       monthly). Changing only the cadence changes BREAKAGE
 *                       (and the daily pacing), holding the gross rate fixed.
 *  • expiry_capped    — a flat % whose accrual EXPIRES after `expiryDays` if
 *                       unclaimed. A shorter expiry forfeits more accrual →
 *                       higher breakage → lower realized cost (a soft anti-
 *                       hoarding control).
 *  • progressive_taper— a base % that TAPERS by `taperPerTier` for each wager
 *                       tier above the floor, floored at `floorRate` — keeps the
 *                       rate generous for small players and throttles the
 *                       whale-heavy dollar concentration.
 */
export type RatePolicy =
  | { kind: "flat_rate"; rate: number; cadence: ClaimCadence }
  | {
      kind: "tiered_by_wager";
      perSegmentRate: Record<SegmentId, number>;
      cadence: ClaimCadence;
    }
  | { kind: "cadence_gated"; rate: number; cadence: ClaimCadence }
  | {
      kind: "expiry_capped";
      rate: number;
      cadence: ClaimCadence;
      /** Days of unclaimed accrual before it forfeits. Shorter → more breakage. */
      expiryDays: number;
    }
  | {
      kind: "progressive_taper";
      /** The most-generous rate, applied to the lowest wager tier. */
      baseRate: number;
      cadence: ClaimCadence;
      /** Fraction (0-1) of the base rate removed per wager tier above the floor. */
      taperPerTier: number;
      /** Lower bound the tapered rate never falls below. */
      floorRate: number;
    };

// ─── Scenario config ────────────────────────────────────────────────────────

/**
 * A complete, shareable scenario definition. Extends the generic
 * {@link BaseScenarioConfig} (id / label / description / schemaVersion) with the
 * rakeback-specific `policy` rate-rule. `schemaVersion` is pinned so
 * saved/exported scenarios can be migrated forward without ambiguity.
 */
export type ScenarioConfig = BaseScenarioConfig & {
  policy: RatePolicy;
};

// ─── Assumptions (the tunable levers) ───────────────────────────────────────

/**
 * Every behavioural / volume assumption the engine multiplies by. Extends the
 * generic {@link BaseAssumptions} (the reward-agnostic volume + claim levers the
 * shared orchestration reads) with the rakeback-SPECIFIC behavioural levers. In
 * the UI each is a slider seeded from a `DEFAULT_*` constant.
 *
 * Rates / probabilities / multipliers — never raw money except `avgBonusUsd`
 * (the real avg rakeback per claim, carried by the generic base for the
 * KPI strip). The engine normalizes / clamps everything defensively, but
 * callers should keep fractions in [0,1].
 *
 * VOLUME is anchored to the REAL measured claimant count (no synthetic
 * population): `baselineClaimants` over `baselinePeriodDays` is scaled to the
 * forecast horizon and modulated by the claim-probability lever relative to its
 * REAL measured default (`baselineClaimProbability`). The real total wager and
 * the real blended rate (below) anchor the rate-policy cost so a policy at the
 * current rate reproduces the real total. See {@link ForecastBaseline}.
 */
export type Assumptions = BaseAssumptions & {
  /** Fractional split of WAGER across segments — engine normalizes to sum 1. */
  segmentMix: Record<SegmentId, number>;
  /**
   * The REAL measured blended rakeback rate (totalRakeback / totalWager) for
   * the period. The reference every policy's effective rate is compared against
   * — a flat policy AT this rate reproduces the real cost. 0-1.
   */
  baselineBlendedRate: number;
  /**
   * Total wager (USD) the rakeback was computed against in the baseline window.
   * The cost base: rakeback cost = wager × effectiveRate × (1 − breakage). Real,
   * from the overview query.
   */
  baselineWager: number;
  /** Share of accrued rakeback never claimed (expired / abandoned), 0-1. */
  breakageRate: number;
  /**
   * Share of rebated wager that is FARMED purely to harvest rakeback (churned
   * straight back out, no real downstream play), 0-1. The leakage channel —
   * concentrated in the dormant / low-volume tiers.
   */
  farmedWagerShare: number;
  /** How strongly a lower rate suppresses farmed-wager leakage, 0-1 (1 = fully elastic). */
  farmCaptureElasticity: number;
  /** Incremental retained downstream GGR per $1 of rakeback paid to genuine players. */
  retentionUplift: number;
  /** Genuine downstream play lost per unit of rate cut, 0-1 (whales most sensitive). */
  rateConversionSensitivity: number;
  /** Wager elasticity: how much a higher rate lifts (or a cut lowers) total wager, 0-1. */
  wagerElasticity: number;
};
