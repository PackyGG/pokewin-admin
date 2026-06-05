/**
 * Serializable models for the SIGNUP-BONUS forecasting / scenario-simulation
 * engine.
 *
 * Everything here is a PLAIN data shape — no functions, no Decimal objects, no
 * Date instances. Every type round-trips through `JSON.parse(JSON.stringify(x))`
 * unchanged so:
 *   • a server component can pass it as a prop into the `"use client"` island
 *     (Next 15 forbids non-serializable props across the RSC boundary), and
 *   • a scenario can be saved / shared / exported as plain JSON.
 *
 * ── Shared foundation ───────────────────────────────────────────────────────
 * The REWARD-AGNOSTIC result / baseline / recommendation shapes live in the
 * shared engine kit (`insights/_forecast-engine`) and are re-exported here so
 * the signup engine + UI consume the same contract as deposit-bonus. Only the
 * signup-SPECIFIC shapes (segment ids, the grant policy, the grant-aware
 * Assumptions / ScenarioConfig) live in this file — they extend the generic
 * base types.
 *
 * ── Why "grant", not "cap" ──────────────────────────────────────────────────
 * A signup bonus is NOT a deposit-matched, window-capped bonus (the deposit-
 * bonus model). It is a FIXED-VALUE grant credited once at signup (the welcome
 * pack) plus optional level-up tranches. There is no per-window dollar cap and
 * no deposit to match against. The policy axis here is therefore the GRANT
 * STRUCTURE: how big the welcome grant is, whether a deposit is required to
 * unlock it (anti-abuse gate), and how many level-up tranches a user can
 * accumulate (the per-user lifetime cap). That is what each scenario varies.
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
 * The behavioural cohorts the signup forecast models. New users split by
 * whether they convert to a first-time depositor (FTD) and — for the non-FTD
 * side — by acquisition intent. Stable string IDs so a saved scenario / a
 * `Record` keyed by segment stays JSON-serializable.
 *
 *  • ftd_high_value      — first-time depositors who deposit meaningfully; the
 *                          grant seeds genuine downstream play (best retention).
 *  • ftd_low_value       — first-time depositors who deposit small; modest but
 *                          real downstream value.
 *  • engaged_no_deposit  — signed up, played with the grant, never deposited;
 *                          the grant is pure cost but some convert later.
 *  • dormant_no_deposit  — claimed the grant, barely engaged; mostly breakage.
 *  • multi_account_abuse — bonus-only / multi-account farmers; the grant is
 *                          pure leakage, suppressed by the deposit gate.
 */
export type SegmentId =
  | "ftd_high_value"
  | "ftd_low_value"
  | "engaged_no_deposit"
  | "dormant_no_deposit"
  | "multi_account_abuse";

// ─── Grant rules (discriminated union) ──────────────────────────────────────

/** Discriminant tag for {@link GrantRule}. */
export type GrantKind = "flat_grant" | "deposit_gated" | "tiered_levelup" | "dynamic_segment";

/**
 * A signup-bonus grant policy. Discriminated on `kind` so a scenario can be
 * persisted / shared as plain JSON and exhaustively matched in the engine.
 *
 *  • flat_grant       — a single flat welcome grant credited to EVERY signup,
 *                       no gate (the current baseline shape). `grantUsd` is the
 *                       per-user award; `perUserCapUsd` caps lifetime grants
 *                       (welcome + any level-ups) per user.
 *  • deposit_gated    — the same flat welcome grant, but UNLOCKED only after a
 *                       qualifying first deposit (`minDepositUsd`). The gate is
 *                       the strongest anti-abuse lever for a signup reward —
 *                       bonus-only farmers never deposit, so they never unlock.
 *  • tiered_levelup   — a smaller instant welcome grant plus level-up tranches
 *                       the user earns by wagering. `instantGrantUsd` is paid up
 *                       front; `levelTranches` extra tranches of `trancheUsd`
 *                       accrue with play (so the cost lands on engaged users).
 *  • dynamic_segment  — per-segment grant sizing (FTD-likely cohorts generous,
 *                       abuse-prone cohorts tiny), an optional deposit gate, and
 *                       a per-user lifetime cap. The "smart targeting" policy.
 */
export type GrantRule =
  | {
      kind: "flat_grant";
      grantUsd: number;
      /** Lifetime cap ($) on total grants per user (welcome + level-ups). */
      perUserCapUsd: number;
    }
  | {
      kind: "deposit_gated";
      grantUsd: number;
      perUserCapUsd: number;
      /** Minimum qualifying first deposit ($) that unlocks the grant. */
      minDepositUsd: number;
    }
  | {
      kind: "tiered_levelup";
      /** Instant welcome grant ($) credited at signup. */
      instantGrantUsd: number;
      /** Number of additional level-up tranches a user can earn. */
      levelTranches: number;
      /** Value ($) of each level-up tranche. */
      trancheUsd: number;
      perUserCapUsd: number;
    }
  | {
      kind: "dynamic_segment";
      perSegmentGrantUsd: Record<SegmentId, number>;
      perUserCapUsd: number;
      /** Minimum qualifying first deposit ($) to unlock; 0 = no gate. */
      minDepositUsd: number;
    };

// ─── Scenario config ────────────────────────────────────────────────────────

/**
 * A complete, shareable scenario definition. Extends the generic
 * {@link BaseScenarioConfig} (id / label / description / schemaVersion) with the
 * signup-specific `grant` policy. `schemaVersion` is pinned so saved/exported
 * scenarios can be migrated forward without ambiguity.
 */
export type ScenarioConfig = BaseScenarioConfig & {
  grant: GrantRule;
};

// ─── Assumptions (the tunable levers) ───────────────────────────────────────

/**
 * Every behavioural / volume assumption the engine multiplies by. Extends the
 * generic {@link BaseAssumptions} (the reward-agnostic volume + claim levers the
 * shared orchestration reads) with the signup-SPECIFIC behavioural levers. In
 * the UI each is a slider seeded from a `DEFAULT_*` constant (behavioural) or
 * from the REAL baseline (volume + value).
 *
 * Rates / probabilities / multipliers — never raw money except `avgBonusUsd`.
 * The engine normalizes / clamps everything defensively, but callers should
 * keep fractions in [0,1].
 *
 * VOLUME is anchored to the REAL measured claimant count (no synthetic
 * population): `baselineClaimants` over `baselinePeriodDays` is scaled to the
 * forecast horizon and modulated by the claim-rate lever relative to its REAL
 * measured default (`baselineClaimProbability`). See {@link ForecastBaseline}.
 *
 * For signup, the generic `claimProbability` lever is the REAL claim rate
 * (claimants ÷ signups) and `depositsPerUserPerWindow` is repurposed as the
 * FTD (first-time-deposit) conversion rate of the signup cohort — the single
 * most important downstream-value driver and the thing a deposit gate prices
 * against.
 */
export type Assumptions = BaseAssumptions & {
  /** Fractional split across segments — engine normalizes to sum 1. */
  segmentMix: Record<SegmentId, number>;
  /** Share of awarded grant never wagered (expired / unused), 0-1. */
  breakageRate: number;
  /** Share of claimants behaving abusively at the BASELINE (ungated) grant, 0-1. */
  abuseShare: number;
  /**
   * How strongly a deposit gate suppresses abuse, 0-1 (1 = the gate captures
   * all baseline abuse). Bonus-only farmers never deposit, so the gate is the
   * dominant abuse-capture channel for a signup reward.
   */
  depositGateCaptureElasticity: number;
  /** Incremental retained revenue per $1 of grant paid to a legit FTD user. */
  retentionUplift: number;
  /**
   * Legit (genuine FTD) conversion lost per unit of deposit-gate friction, 0-1.
   * A deposit gate deters some genuine new users who would have converted after
   * trying the product free — the honest cost of gating.
   */
  legitConversionSensitivity: number;
};
