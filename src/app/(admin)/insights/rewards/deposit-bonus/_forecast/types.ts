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
 */

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
 * A complete, shareable scenario definition. `schemaVersion` is pinned so
 * saved/exported scenarios can be migrated forward without ambiguity.
 */
export type ScenarioConfig = {
  /** Stable key, e.g. "A-baseline", "split-10h". */
  id: string;
  label: string;
  description: string;
  cap: CapRule;
  /** Bump-safe version tag for persisted scenarios. */
  schemaVersion: 1;
};

// ─── Assumptions (the tunable levers) ───────────────────────────────────────

/**
 * Every behavioural / volume assumption the engine multiplies by. In the UI
 * each of these is exposed as a slider seeded from a `DEFAULT_*` constant.
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
export type Assumptions = {
  /** REAL distinct claimants measured over `baselinePeriodDays`. The volume anchor. */
  baselineClaimants: number;
  /** Day-span the real `baselineClaimants` was measured over (≥1). */
  baselinePeriodDays: number;
  /**
   * REAL measured claim probability the slider defaults to — the reference the
   * tunable `claimProbability` is normalized against (so the default lever
   * leaves the real claimant volume unchanged). 0-1.
   */
  baselineClaimProbability: number;
  /** Fractional split across segments — engine normalizes to sum 1. */
  segmentMix: Record<SegmentId, number>;
  /** Baseline deposit frequency per user within one cap window. */
  depositsPerUserPerWindow: number;
  /**
   * P(claims a bonus | deposited), 0-1. Defaults to the REAL measured ratio
   * (`baselineClaimProbability`); tunable for what-if. The engine scales the
   * real claimant volume by `claimProbability / baselineClaimProbability`, so
   * the default leaves volume at the real count and moving the slider explores
   * a higher / lower claim rate.
   */
  claimProbability: number;
  /** Baseline average bonus (USD) BEFORE the cap clamp is applied. */
  avgBonusUsd: number;
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
  /** Forecast horizon in days (1 / 7 / 30 / 90). */
  windowDays: number;
};

// ─── Result models ──────────────────────────────────────────────────────────

/** Per-segment forecast breakdown. All money in USD, House-POV. */
export type PerSegment = {
  segment: SegmentId;
  label: string;
  /** Claimants attributed to this segment over the horizon. */
  claimants: number;
  /** Bonus cost (USD) attributable to this segment over the horizon. */
  bonusCost: number;
  /** Bonus leaked to abusive behaviour (USD), after stricter-cap capture. */
  abuseLeakage: number;
  /** Retained downstream revenue (USD) from legit bonus to this segment. */
  retainedRevenue: number;
  /** NGR delta (USD) attributable to this segment, House-POV. */
  ngrImpact: number;
  /** The $ cap this segment effectively faces under the scenario. */
  effectiveCapUsd: number;
};

/** One day of the projected horizon. */
export type DailyPoint = {
  /** 0-indexed day within the horizon. */
  day: number;
  /** Bonus cost paid on this day (USD). */
  bonusCost: number;
  /** Running total bonus cost through this day (USD). */
  cumulativeCost: number;
  /** Savings vs the baseline scenario on this day (USD, +ve = cheaper). */
  savingsVsBaseline: number;
  /** Abuse leakage on this day (USD). */
  abuseLeakage: number;
};

/**
 * The complete forecast for a single scenario. Every field is House-POV:
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = good for the house
 *     (render emerald),
 *   • `bonusCost` / `abuseLeakage` are house outflows (render rose / amber).
 */
export type SimulationResult = {
  scenarioId: string;
  /** Total projected bonus payout cost over the horizon (USD). */
  bonusCost: number;
  /**
   * Net house P&L attributable to the program over the horizon (USD).
   * = -netLoss. Positive = the program nets the house money.
   */
  marginImpact: number;
  /** Net house loss attributable to the program (USD, ≥0 when loss-making). */
  netLoss: number;
  /** GROSS savings vs the baseline scenario (USD, before retention loss). */
  savingsVsBaseline: number;
  /**
   * NET savings vs baseline AFTER subtracting retained-revenue / conversion
   * loss caused by tightening (USD). This is the honest "what we actually
   * save" number — always ≤ `savingsVsBaseline` for stricter scenarios.
   */
  netSavingsVsBaseline: number;
  /** Bonus leaked to abusive behaviour over the horizon (USD). */
  abuseLeakage: number;
  /** Retained downstream revenue from legit bonus over the horizon (USD). */
  retainedRevenue: number;
  /**
   * NGR delta = downstream GGR proxy − bonusCost (USD), House-POV.
   * Positive = the program is NGR-accretive.
   */
  ngrImpact: number;
  /** UX friction composite, 0-100 (higher = worse experience). */
  frictionScore: number;
  /** ±band on the projected `bonusCost` (USD). low < mid < high. */
  confidenceBand: { low: number; mid: number; high: number };
  /** Per-segment breakdown. */
  perSegment: PerSegment[];
  /** Day-by-day series over the horizon. */
  dailySeries: DailyPoint[];
};

// ─── Recommendations ────────────────────────────────────────────────────────

/** Which award a recommendation carries (drives the Badge variant). */
export type RecommendationBadge =
  | "highest-savings"
  | "lowest-friction"
  | "best-balance";

/** A rule-based insight pointing at one winning scenario. */
export type Recommendation = {
  /** The scenario this recommendation crowns. */
  scenarioId: string;
  badge: RecommendationBadge;
  /** Short headline, e.g. "Best net savings". */
  headline: string;
  /** One-line rationale with the concrete numbers. */
  detail: string;
};

// ─── Baseline anchor (real production input) ────────────────────────────────

/**
 * The REAL baseline the server fetches once (from the canonical deposit-bonus
 * queries) and hands the engine so the forecast anchors on production numbers
 * instead of recomputing cost from a separate rollup.
 *
 * Sourced from `getDepositBonusOverview` + `getDepositBonusCapHitRate` +
 * `getDepositBonusROI`. Every field here is REAL (see the DEMO-vs-real table
 * in the engine docs / `constants.ts`). The behavioural assumptions
 * (claim prob, abuse share, retention uplift, …) are NOT here — those are
 * tunable DEMO seeds in {@link Assumptions}.
 */
export type ForecastBaseline = {
  /** Real total bonus cost in the source window (USD). `overview.totalCost`. */
  totalCost: number;
  /** Real distinct claimants. `overview.uniqueClaimants`. */
  uniqueClaimants: number;
  /**
   * Day-span the baseline was measured over (the selected period; lifetime is
   * bounded to the standard lookback). The volume anchor scales `uniqueClaimants`
   * from this span to the forecast horizon. Always ≥1.
   */
  periodDays: number;
  /**
   * Real measured claim probability = `uniqueClaimants / distinct depositors` in
   * the SAME window + scope. The claim-probability slider defaults to this.
   * `null` when there were no depositors (divide-by-zero guard → empty state).
   */
  claimProbability: number | null;
  /** Real average bonus (USD). `overview.avg`. */
  avgBonusUsd: number;
  /** Real largest single bonus = empirical cap (USD). `overview.max`. */
  empiricalCapUsd: number;
  /** Real cap-hit rate, 0-1. `capHitRate.capHitRate`. May be null if unavailable. */
  capHitRate: number | null;
  /** Real blended ROI (downstream GGR / cost). `roi.blendedRoi`. May be null. */
  blendedRoi: number | null;
  /** Real avg downstream GGR per claimant (USD). `roi.avgGgrPerClaimant`. */
  avgGgrPerClaimant: number;
};
