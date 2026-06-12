/**
 * Edge Plan 2.0 — Daily-pack COVERAGE + INCREMENTAL profit math (pure module).
 *
 * ── The program (owner spec) ────────────────────────────────────────────────
 * Daily packs are gated behind WAGER-LOSS:
 *
 *   • UNLOCK  — a ONE-TIME stock of wager-loss (`levelRequirementUsd`) the user
 *     must accumulate to reach the pack's level. It happens once per user and
 *     is therefore NOT part of any recurring 30-day flow. We surface it
 *     separately (`oneTimeUnlockLossUsd`) for context only — it never enters
 *     the coverage ratio or the incremental-profit figure.
 *
 *   • RE-LOCK — the RECURRING flow: every 30 days the user must show
 *     `relockPct × levelRequirementUsd` of fresh wager-loss or the pack locks
 *     again. This recurring gated loss is the flow the whole system is built
 *     on, and it is what `requiredLossFlowUsd30d` measures.
 *
 * In exchange the pack gives back EV: `evPerOpenUsd × opensPerWindow`,
 * normalized from the pack's own `windowDays` to a 30-day figure
 * (`givebackUsd30d`).
 *
 * ── Accounting honesty (NO double count) ────────────────────────────────────
 * Wager-loss IS house profit — but the gated loss is ALREADY inside GGR.
 * Users were losing money before the pack program existed. So the recurring
 * gated flow must NEVER be added to GGR or booked as new profit wholesale —
 * that would double-count revenue that GGR already carries.
 *
 * Instead the model splits the story into two explicitly different numbers:
 *
 *   1. COVERAGE (`coverageRatio` = requiredLossFlowUsd30d / givebackUsd30d):
 *      how many dollars of gated, GGR-resident loss the program demands per
 *      dollar of EV it gives back. Owner example: a pack that requires 1% of
 *      its level requirement every 30d but returns only 0.25% in EV has
 *      coverage 4.0× — structurally profit-positive *if* any of the gated
 *      loss is truly caused by the program.
 *
 *   2. INCREMENTAL profit (`theoreticalIncrementalProfitUsd30d`):
 *        incrementality × requiredLossFlowUsd30d − givebackUsd30d
 *      `incrementality` (0..1, a GLOBAL, explicitly stated assumption) is the
 *      share of the gated loss that would NOT have happened without the pack
 *      program. Only that share may be credited as new house profit; the
 *      giveback is always a true incremental cost.
 *
 * The result is intentionally NOT clamped at zero. At incrementality = 0 the
 * profit is exactly −givebackUsd30d: if none of the gated loss is caused by
 * the program (users would have lost that money anyway), the program's only
 * marginal effect on the house is paying out its giveback. That negative
 * number is the honest FLOOR of the estimate — clamping it to zero would hide
 * the fact that, under the most conservative assumption, the program is a
 * pure cost. We show the floor, we do not flatten it.
 *
 * ── Purity contract ─────────────────────────────────────────────────────────
 * Plain-number inputs only (USD amounts, day counts, 0..1 fractions). No DB,
 * no React, no imports from `_model-v2` / `_baseline-v2` — this module wires
 * into any baseline shape unchanged.
 *
 * ── Edge-case semantics (all outputs stay finite) ───────────────────────────
 *   • zero claimers          → all 30d flows are $0; perUser unit economics
 *                              are still computed from the per-user formulas.
 *   • zero opens / zero EV   → givebackUsd30d = $0 → coverageRatio = null
 *                              (never Infinity), profit = incrementality ×
 *                              requiredLossFlow (pure upside under the stated
 *                              assumption — giveback costs nothing).
 *   • relockPct = 0          → requiredLossFlowUsd30d = $0 → coverage 0 and
 *                              profit = −givebackUsd30d (honest cost).
 *   • eligibleUsers < claimers → claimRate > 1 is reported AS-IS (it flags
 *                              inconsistent inputs; we don't silently clamp).
 *   • windowDays ≤ 0 / non-finite → no valid window: givebackUsd30d = $0.
 *   • non-finite / negative numeric inputs are sanitized to 0 (fractions are
 *     additionally clamped to [0,1]) so every output is a finite number.
 */

/** The recurring re-lock cadence the model normalizes every flow to. */
export const RELOCK_WINDOW_DAYS = 30;

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface PackCoverageInput {
  /** Optional label for display / aggregation (not used in any math). */
  id?: string;
  /** ONE-TIME wager-loss (USD) required to reach the pack's level (unlock). */
  levelRequirementUsd: number;
  /**
   * Fraction (0..1) of `levelRequirementUsd` required as FRESH wager-loss per
   * 30 days to keep the pack unlocked (the recurring re-lock gate).
   */
  relockPct: number;
  /** Planned EV (USD) given back to the user per pack open. */
  evPerOpenUsd: number;
  /** Average opens per CLAIMER within one `windowDays` window. */
  opensPerWindow: number;
  /** Users actively claiming the pack (drive the 30d flows). */
  claimers: number;
  /** Users eligible for the pack (context; may be < claimers on bad inputs). */
  eligibleUsers: number;
  /** Length in days of the window `opensPerWindow` is measured over. */
  windowDays: number;
}

export interface PackCoverageGlobalInput {
  /**
   * GLOBAL incrementality assumption (0..1): share of the re-lock-gated
   * wager-loss that would NOT have happened without the pack program. This is
   * the single explicit knob that converts GGR-resident "coverage" into
   * creditable incremental profit — it must always be stated next to any
   * profit figure derived here.
   */
  incrementality: number;
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

/** Per-user (per-claimer) unit economics — independent of cohort size. */
export interface PackCoveragePerUser {
  /** Recurring re-lock-gated wager-loss per claimer per 30d (USD). */
  requiredLossUsd30d: number;
  /** Planned EV giveback per claimer per 30d (USD). */
  givebackUsd30d: number;
  /**
   * incrementality × requiredLossUsd30d − givebackUsd30d (USD per 30d).
   * Negative values are shown honestly (see module header — floor, not clamp).
   */
  incrementalProfitUsd30d: number;
  /** ONE-TIME unlock loss per user (USD) — context only, NOT a 30d flow. */
  oneTimeUnlockLossUsd: number;
  /**
   * claimers / eligibleUsers; null when eligibleUsers is 0. Values > 1 are
   * reported as-is and flag inconsistent inputs (eligible < claimers).
   */
  claimRate: number | null;
}

export interface PackCoverageResult {
  /** Echoes `input.id` (sanitized inputs are NOT echoed — by design). */
  id: string | null;
  /**
   * RECURRING re-lock-gated wager-loss flow across all claimers per 30d:
   * claimers × relockPct × levelRequirementUsd. This money is ALREADY inside
   * GGR — it is coverage, not additive profit.
   */
  requiredLossFlowUsd30d: number;
  /**
   * ONE-TIME unlock stock across claimers (claimers × levelRequirementUsd).
   * Informational only: excluded from coverage and from incremental profit
   * because unlock happens once per user, not per 30d window.
   */
  oneTimeUnlockLossUsd: number;
  /** Planned EV giveback across claimers, normalized to 30d (USD). */
  givebackUsd30d: number;
  /**
   * requiredLossFlowUsd30d / givebackUsd30d. Null when giveback is $0
   * (no opens / no EV / no claimers) — never Infinity or NaN.
   */
  coverageRatio: number | null;
  /**
   * incrementality × requiredLossFlowUsd30d − givebackUsd30d (USD per 30d).
   * NOT clamped: at incrementality 0 this is exactly −givebackUsd30d, the
   * honest floor (program = pure giveback cost, zero credited loss).
   */
  theoreticalIncrementalProfitUsd30d: number;
  /** Per-claimer unit view (well-defined even when claimers = 0). */
  perUser: PackCoveragePerUser;
}

export interface PackCoverageAggregate {
  /** Per-pack results, same order as the inputs. */
  packs: PackCoverageResult[];
  /** Σ per-pack requiredLossFlowUsd30d. */
  requiredLossFlowUsd30d: number;
  /** Σ per-pack oneTimeUnlockLossUsd (context only, NOT a 30d flow). */
  oneTimeUnlockLossUsd: number;
  /** Σ per-pack givebackUsd30d. */
  givebackUsd30d: number;
  /** Aggregate Σ requiredLoss / Σ giveback; null when Σ giveback is $0. */
  coverageRatio: number | null;
  /**
   * Σ per-pack theoreticalIncrementalProfitUsd30d. Because `incrementality`
   * is global and the formula is linear, this equals
   * incrementality × Σ requiredLossFlow − Σ giveback exactly.
   */
  theoreticalIncrementalProfitUsd30d: number;
  /** Σ claimers across packs (a user claiming 2 packs counts twice). */
  totalClaimers: number;
  /** Σ eligibleUsers across packs (same caveat as totalClaimers). */
  totalEligibleUsers: number;
}

// ─── Sanitization (keeps every output finite on degenerate inputs) ──────────

/** Non-finite → fallback; otherwise the value unchanged. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** USD amounts / counts / day lengths: non-finite or negative → 0. */
function nonNegative(value: number): number {
  return Math.max(0, finiteOr(value, 0));
}

/** Fractions: non-finite → 0, then clamped into [0, 1]. */
function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, finiteOr(value, 0)));
}

/** Defensive copy of a pack input with every numeric field made safe. */
export function sanitizePackCoverageInput(input: PackCoverageInput): PackCoverageInput {
  return {
    id: input.id,
    levelRequirementUsd: nonNegative(input.levelRequirementUsd),
    relockPct: clampFraction(input.relockPct),
    evPerOpenUsd: nonNegative(input.evPerOpenUsd),
    opensPerWindow: nonNegative(input.opensPerWindow),
    claimers: nonNegative(input.claimers),
    eligibleUsers: nonNegative(input.eligibleUsers),
    windowDays: nonNegative(input.windowDays),
  };
}

/** Global input with `incrementality` clamped into [0, 1]. */
export function sanitizePackCoverageGlobalInput(
  global: PackCoverageGlobalInput,
): PackCoverageGlobalInput {
  return { incrementality: clampFraction(global.incrementality) };
}

// ─── Core math ───────────────────────────────────────────────────────────────

/**
 * Coverage ratio = requiredLoss / giveback, null-safe: a $0 giveback yields
 * null (not Infinity) so callers must render "n/a" instead of a fake number.
 */
export function coverageRatioOf(
  requiredLossUsd: number,
  givebackUsd: number,
): number | null {
  if (!(givebackUsd > 0)) return null;
  return requiredLossUsd / givebackUsd;
}

/**
 * Incremental profit = incrementality × requiredLoss − giveback.
 * Deliberately unclamped — see module header ("floor, not clamp").
 */
export function incrementalProfitUsd(
  requiredLossUsd: number,
  givebackUsd: number,
  incrementality: number,
): number {
  return incrementality * requiredLossUsd - givebackUsd;
}

/** Compute coverage + incremental profit for a single pack. */
export function computePackCoverage(
  input: PackCoverageInput,
  global: PackCoverageGlobalInput,
): PackCoverageResult {
  const p = sanitizePackCoverageInput(input);
  const g = sanitizePackCoverageGlobalInput(global);

  // Per-claimer unit economics (independent of cohort size).
  // Re-lock is defined per 30d, so the required flow needs NO window
  // normalization; only the opens-based giveback is measured over
  // `windowDays` and must be rescaled to the 30d cadence.
  const requiredLossPerUser30d = p.relockPct * p.levelRequirementUsd;
  const windowScale = p.windowDays > 0 ? RELOCK_WINDOW_DAYS / p.windowDays : 0;
  const givebackPerUser30d = p.evPerOpenUsd * p.opensPerWindow * windowScale;
  const claimRate = p.eligibleUsers > 0 ? p.claimers / p.eligibleUsers : null;

  // Cohort flows (per 30d) — recurring re-lock flow only; the one-time
  // unlock stock is surfaced separately and never mixed into the flows.
  const requiredLossFlowUsd30d = p.claimers * requiredLossPerUser30d;
  const givebackUsd30d = p.claimers * givebackPerUser30d;
  const oneTimeUnlockLossUsd = p.claimers * p.levelRequirementUsd;

  return {
    id: p.id ?? null,
    requiredLossFlowUsd30d,
    oneTimeUnlockLossUsd,
    givebackUsd30d,
    coverageRatio: coverageRatioOf(requiredLossFlowUsd30d, givebackUsd30d),
    theoreticalIncrementalProfitUsd30d: incrementalProfitUsd(
      requiredLossFlowUsd30d,
      givebackUsd30d,
      g.incrementality,
    ),
    perUser: {
      requiredLossUsd30d: requiredLossPerUser30d,
      givebackUsd30d: givebackPerUser30d,
      incrementalProfitUsd30d: incrementalProfitUsd(
        requiredLossPerUser30d,
        givebackPerUser30d,
        g.incrementality,
      ),
      oneTimeUnlockLossUsd: p.levelRequirementUsd,
      claimRate,
    },
  };
}

/**
 * Aggregate across packs = plain sums of the per-pack results (the global
 * incrementality keeps the profit formula linear, so the summed profit equals
 * the profit of the summed flows — no re-derivation, no drift).
 */
export function computePackCoverageAggregate(
  inputs: readonly PackCoverageInput[],
  global: PackCoverageGlobalInput,
): PackCoverageAggregate {
  const g = sanitizePackCoverageGlobalInput(global);
  const packs = inputs.map((input) => computePackCoverage(input, g));

  let requiredLossFlowUsd30d = 0;
  let oneTimeUnlockLossUsd = 0;
  let givebackUsd30d = 0;
  let theoreticalIncrementalProfitUsd30d = 0;
  let totalClaimers = 0;
  let totalEligibleUsers = 0;

  for (const pack of packs) {
    requiredLossFlowUsd30d += pack.requiredLossFlowUsd30d;
    oneTimeUnlockLossUsd += pack.oneTimeUnlockLossUsd;
    givebackUsd30d += pack.givebackUsd30d;
    theoreticalIncrementalProfitUsd30d += pack.theoreticalIncrementalProfitUsd30d;
  }
  for (const input of inputs) {
    totalClaimers += nonNegative(input.claimers);
    totalEligibleUsers += nonNegative(input.eligibleUsers);
  }

  return {
    packs,
    requiredLossFlowUsd30d,
    oneTimeUnlockLossUsd,
    givebackUsd30d,
    coverageRatio: coverageRatioOf(requiredLossFlowUsd30d, givebackUsd30d),
    theoreticalIncrementalProfitUsd30d,
    totalClaimers,
    totalEligibleUsers,
  };
}
