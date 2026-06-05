/**
 * engine.ts — the pure SIGNUP-BONUS forecast simulator.
 *
 * Side-effect-free, dep-free, primitives-only (mirrors `edge-calc/math.ts` and
 * the deposit-bonus reference engine). Imports ONLY `constants.ts` + `types.ts`
 * and the shared generic guards. No DB, no React, no Date, no RNG. Safe to call
 * from a server component, the client island's `useMemo`, a check harness, or a
 * future export — same numbers everywhere.
 *
 * ── House-POV ──────────────────────────────────────────────────────────────
 * Every money output is from the HOUSE perspective:
 *   • `bonusCost` / `abuseLeakage` are house OUTFLOWS (render rose / amber).
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = house GAIN (emerald).
 *
 * ── Directional contract (hard-encoded — this is the spec) ──────────────────
 *  | Lever / policy                       | Encoded effect                     |
 *  |--------------------------------------|------------------------------------|
 *  | Smaller flat grant                   | ↓ paid grant per claimant → ↓ cost |
 *  | Deposit gate (deposit_gated /        | paid population collapses toward   |
 *  | dynamic with minDeposit > 0)         | the FTD rate → big cost cut AND    |
 *  |                                      | strong abuse capture; BUT some     |
 *  |                                      | genuine FTDs are deterred → net    |
 *  |                                      | savings < gross.                   |
 *  | Tiered / level-up                    | small instant grant to everyone +  |
 *  |                                      | tranches only to engaged share →   |
 *  |                                      | cost shifts onto players, abuse↓.  |
 *  | Roomier per-user lifetime cap        | breakage rises above the           |
 *  |                                      | over-generous threshold.           |
 *  | Dynamic per-segment grant            | generous to FTD-likely cohorts     |
 *  |                                      | (retention), tiny to abuse cohort  |
 *  |                                      | (kills leakage).                   |
 */

import {
  BASELINE_GRANT_USD,
  CONFIDENCE_BAND_SPREAD,
  DEFAULT_FTD_CONVERSION_RATE,
  DEPOSIT_GATE_RETENTION_FLOOR,
  EPSILON,
  FRICTION_W_DEPOSIT_GATE,
  FRICTION_W_GATE_STEEPNESS,
  FRICTION_W_TIERING,
  GATE_STEEPNESS_REFERENCE_USD,
  INSTANT_GRANT_FRONTLOAD,
  OVERGENEROUS_BREAKAGE_SLOPE,
  OVERGENEROUS_CAP_THRESHOLD_USD,
  SEGMENTS,
  TIERED_GRANT_FRONTLOAD,
} from "./constants";
import type {
  Assumptions,
  DailyPoint,
  GrantRule,
  PerSegment,
  ScenarioConfig,
  SegmentId,
  SimulationResult,
} from "./types";
// The GENERIC numeric guards + orchestration live in the shared engine kit.
// Signup re-exports the guards (so its `index.ts` surface mirrors the
// reference) and wraps the generic `simulateSet` / `buildDailySeries` /
// `scaleResultMoney` with grant-aware signatures.
import {
  buildDailySeries as buildDailySeriesGeneric,
  clamp,
  clamp01,
  finite,
  safeDiv,
  scaleResultMoney,
  simulateSet as simulateSetGeneric,
} from "../../../_forecast-engine";

// Re-export the shared numeric guards under the signup engine surface so
// existing imports stay valid.
export { clamp, clamp01, safeDiv, scaleResultMoney };

// ─── Grant geometry ──────────────────────────────────────────────────────────

/** The minimum qualifying deposit ($) a grant rule gates on (0 = no gate). */
export function gateMinDepositUsd(grant: GrantRule): number {
  switch (grant.kind) {
    case "flat_grant":
    case "tiered_levelup":
      return 0;
    case "deposit_gated":
    case "dynamic_segment":
      return Math.max(0, finite(grant.minDepositUsd));
  }
}

/** Whether a grant rule imposes a deposit gate at all. */
export function hasDepositGate(grant: GrantRule): boolean {
  return gateMinDepositUsd(grant) > 0;
}

/** The per-user lifetime grant cap ($) a rule advertises. */
export function perUserCapUsd(grant: GrantRule): number {
  return Math.max(0, finite(grant.perUserCapUsd));
}

/**
 * The nominal MAX grant a single new user can receive under a rule, BEFORE the
 * per-user lifetime cap clamps it (segment-agnostic, a representative figure):
 *   • flat / deposit_gated — the flat grant.
 *   • tiered_levelup       — instant + every level tranche (the fully-leveled
 *                            user; most users earn fewer, handled per-segment).
 *   • dynamic_segment      — the mean per-segment grant.
 */
export function nominalGrantUsd(grant: GrantRule): number {
  switch (grant.kind) {
    case "flat_grant":
    case "deposit_gated":
      return Math.max(0, finite(grant.grantUsd));
    case "tiered_levelup":
      return (
        Math.max(0, finite(grant.instantGrantUsd)) +
        Math.max(0, finite(grant.levelTranches)) * Math.max(0, finite(grant.trancheUsd))
      );
    case "dynamic_segment": {
      const vals = SEGMENTS.map((s) => Math.max(0, finite(grant.perSegmentGrantUsd[s.id])));
      const sum = vals.reduce((a, b) => a + b, 0);
      return safeDiv(sum, vals.length);
    }
  }
}

/**
 * The grant a given SEGMENT receives under a rule, before the per-user cap.
 *   • flat / deposit_gated — the flat grant (segment-agnostic).
 *   • tiered_levelup       — instant grant + the tranches that segment is
 *                            modeled to earn (engaged/FTD cohorts level up more;
 *                            dormant/abuse cohorts earn ~none). Encodes that
 *                            level-up cost lands on users who actually play.
 *   • dynamic_segment      — the per-segment grant.
 * Clamped to the per-user lifetime cap.
 */
export function grantForSegment(grant: GrantRule, segmentId: SegmentId): number {
  const cap = perUserCapUsd(grant);
  let raw: number;
  switch (grant.kind) {
    case "flat_grant":
    case "deposit_gated":
      raw = Math.max(0, finite(grant.grantUsd));
      break;
    case "tiered_levelup": {
      const instant = Math.max(0, finite(grant.instantGrantUsd));
      const tranches = Math.max(0, finite(grant.levelTranches));
      const trancheUsd = Math.max(0, finite(grant.trancheUsd));
      // Fraction of the available tranches this segment is modeled to earn.
      raw = instant + tranches * trancheUsd * segmentLevelUpShare(segmentId);
      break;
    }
    case "dynamic_segment":
      raw = Math.max(0, finite(grant.perSegmentGrantUsd[segmentId]));
      break;
  }
  return Math.min(raw, cap > 0 ? cap : raw);
}

/**
 * Modeled fraction of available level-up tranches a segment earns. Engaged /
 * FTD cohorts play and level up; dormant / abuse cohorts barely touch the
 * product, so they earn almost none. Pure, deterministic, 0-1.
 */
export function segmentLevelUpShare(segmentId: SegmentId): number {
  switch (segmentId) {
    case "ftd_high_value":
      return 0.9;
    case "ftd_low_value":
      return 0.6;
    case "engaged_no_deposit":
      return 0.5;
    case "dormant_no_deposit":
      return 0.08;
    case "multi_account_abuse":
      return 0.05;
  }
}

/**
 * The share of a segment's claimants whose grant is actually PAID under the
 * rule's deposit gate. An ungated rule pays everyone (1.0). A gated rule pays:
 *   • FTD cohorts in full (they deposit by definition),
 *   • a deposit-gate retention floor of the non-FTD engaged/dormant cohorts
 *     (some deposit just to unlock),
 *   • almost none of the abuse cohort (bonus-only farmers never deposit).
 * Scaled by the gate-capture elasticity lever (a soft gate pays more through).
 */
export function paidShareUnderGate(
  grant: GrantRule,
  segmentId: SegmentId,
  gateElasticity: number,
): number {
  if (!hasDepositGate(grant)) return 1;
  const elasticity = clamp01(gateElasticity);
  // ungatedPass = the fraction that would slip through a hypothetical zero-
  // strength gate; gatedPass = the fraction at full strength. The elasticity
  // interpolates: a fully-elastic gate (1.0) applies the full gated screen.
  const gatedPass = depositGatePassFraction(segmentId);
  return clamp01(1 - elasticity * (1 - gatedPass));
}

/**
 * Fraction of a segment that passes a FULL-strength deposit gate (makes a
 * qualifying deposit). FTD cohorts pass entirely; non-FTD cohorts pass only at
 * the retention floor; abuse barely passes. Pure, 0-1.
 */
export function depositGatePassFraction(segmentId: SegmentId): number {
  switch (segmentId) {
    case "ftd_high_value":
    case "ftd_low_value":
      return 1;
    case "engaged_no_deposit":
      return DEPOSIT_GATE_RETENTION_FLOOR * 2;
    case "dormant_no_deposit":
      return DEPOSIT_GATE_RETENTION_FLOOR;
    case "multi_account_abuse":
      return DEPOSIT_GATE_RETENTION_FLOOR * 0.5;
  }
}

// ─── Friction ─────────────────────────────────────────────────────────────────

/**
 * UX friction composite, 0-100 (higher = worse). Weighted sum of:
 *   • deposit gate     — a hard eligibility wall before the grant (dominant).
 *   • gate steepness   — how high the minimum deposit is vs the reference.
 *   • tiering          — a multi-tier level-up structure (effort to fully earn).
 * The ungated flat baseline scores ~0 (a free instant grant is frictionless).
 */
export function frictionScore(grant: GrantRule): number {
  const gate = hasDepositGate(grant) ? 1 : 0;
  const steepness = clamp01(safeDiv(gateMinDepositUsd(grant), GATE_STEEPNESS_REFERENCE_USD));

  const tierCount =
    grant.kind === "tiered_levelup" ? Math.max(0, finite(grant.levelTranches)) : 0;
  // Saturate the tiering penalty at ~4 tranches.
  const tiering = clamp01(safeDiv(tierCount, 4));

  const raw =
    FRICTION_W_DEPOSIT_GATE * gate +
    FRICTION_W_GATE_STEEPNESS * steepness +
    FRICTION_W_TIERING * tiering;

  return clamp(raw, 0, 100);
}

// ─── Behavioural scalars ───────────────────────────────────────────────────────

/**
 * How much of baseline abuse a policy CAPTURES (prevents). The deposit gate is
 * the dominant channel for a signup reward: an ungated policy captures nothing,
 * a gated policy captures `elasticity × (1 − abusePassFraction)`. A tiered
 * policy also captures a little (abuse cohorts can't earn level-ups).
 */
export function abuseCapture(grant: GrantRule, gateElasticity: number): number {
  if (hasDepositGate(grant)) {
    const abusePass = depositGatePassFraction("multi_account_abuse");
    return clamp01(clamp01(gateElasticity) * (1 - abusePass));
  }
  if (grant.kind === "tiered_levelup") {
    // No instant-grant gate, but level-up tranches are unreachable for abuse →
    // the abuse-only portion of the grant (tranches) is structurally captured.
    const instant = Math.max(0, finite(grant.instantGrantUsd));
    const nominal = nominalGrantUsd(grant);
    return clamp01(1 - safeDiv(instant, nominal));
  }
  return 0;
}

/**
 * Legit (genuine FTD) conversion LOST from a deposit gate's friction. Only a
 * gated policy sacrifices genuine conversion; the loss scales with the gate's
 * steepness and the sensitivity lever. Ungated policies lose nothing.
 */
export function conversionLossFromGate(grant: GrantRule, sensitivity: number): number {
  if (!hasDepositGate(grant)) return 0;
  const steepness = clamp01(safeDiv(gateMinDepositUsd(grant), GATE_STEEPNESS_REFERENCE_USD));
  // A gate always carries SOME baseline deterrence even at a low threshold.
  const gateFriction = clamp01(0.5 + 0.5 * steepness);
  return clamp01(clamp01(sensitivity) * gateFriction);
}

/**
 * Breakage at a given per-user cap: the baseline breakage rate plus a linear
 * climb once the lifetime cap exceeds the over-generous threshold (roomier caps
 * let more grant pile up unused on dormant accounts).
 */
export function breakageAtCap(grant: GrantRule, baseRate: number): number {
  const over = Math.max(0, perUserCapUsd(grant) - OVERGENEROUS_CAP_THRESHOLD_USD);
  return clamp01(clamp01(baseRate) + over * OVERGENEROUS_BREAKAGE_SLOPE);
}

// ─── Core simulate ───────────────────────────────────────────────────────────

/** Normalize a segment mix to fractions summing to 1 (falls back to even). */
export function normalizeSegmentMix(mix: Record<SegmentId, number>): Record<SegmentId, number> {
  const raw = SEGMENTS.map((s) => Math.max(0, finite(mix[s.id])));
  const total = raw.reduce((a, b) => a + b, 0);
  const out = {} as Record<SegmentId, number>;
  if (total <= EPSILON) {
    const even = 1 / SEGMENTS.length;
    for (const s of SEGMENTS) out[s.id] = even;
    return out;
  }
  SEGMENTS.forEach((s, i) => {
    out[s.id] = raw[i] / total;
  });
  return out;
}

/** Whether a segment is a first-time-deposit cohort (drives retention base). */
export function isFtdSegment(segmentId: SegmentId): boolean {
  return segmentId === "ftd_high_value" || segmentId === "ftd_low_value";
}

/**
 * Run the full forecast for one scenario.
 *
 * @param scenario    the grant policy to simulate
 * @param assumptions the behavioural / volume levers (sliders)
 * @param window      `{ days }` — horizon length; falls back to assumptions.windowDays
 */
export function simulate(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
  window: { days: number },
): SimulationResult {
  const days = Math.max(1, finite(window.days) || finite(assumptions.windowDays) || 30);
  const grant = scenario.grant;

  const mix = normalizeSegmentMix(assumptions.segmentMix);
  const abuseShare = clamp01(assumptions.abuseShare);
  const gateElasticity = clamp01(assumptions.depositGateCaptureElasticity);

  // Policy-derived scalars (computed once).
  const capture = abuseCapture(grant, gateElasticity);
  const convLoss = conversionLossFromGate(grant, assumptions.legitConversionSensitivity);
  const breakage = breakageAtCap(grant, assumptions.breakageRate);
  const retentionUplift = Math.max(0, finite(assumptions.retentionUplift));

  // FTD (first-time-deposit) conversion rate — the share of signups that make a
  // qualifying first deposit (the repurposed generic `depositsPerUserPerWindow`
  // lever). It is the dominant downstream-value driver: more FTDs → each $ of
  // legit grant generates more retained revenue. Modeled as a multiplier on the
  // retention base RELATIVE to its named default, so the default lever is
  // neutral (factor 1.0) and moving it scales retained revenue / NGR honestly
  // without distorting the cost anchor. Bounded so an extreme slider can't blow
  // retention past a sane ceiling.
  const ftdRate = clamp01(assumptions.depositsPerUserPerWindow);
  const ftdFactor = clamp(safeDiv(ftdRate, DEFAULT_FTD_CONVERSION_RATE), 0, 3);

  // ── Volume — anchored to the REAL measured claimant count, identical across
  // every policy at the GROSS (pre-gate) level ──
  // Claims over the horizon = real claimants (measured over `baselinePeriodDays`)
  // linearly scaled to the forecast horizon, then modulated by the claim-rate
  // lever RELATIVE to its real measured default. At the default lever the
  // modulation is 1.0, so the gross volume is exactly the real count scaled to
  // the horizon; moving the slider explores a higher / lower claim rate. The
  // DEPOSIT GATE then reduces the PAID share per segment (below) — that is where
  // a gated policy diverges on cost / abuse.
  const baselineClaimants = Math.max(0, finite(assumptions.baselineClaimants));
  const baselinePeriodDays = Math.max(1, finite(assumptions.baselinePeriodDays));
  const claimProb = clamp01(assumptions.claimProbability);
  const baseClaimProb = clamp01(assumptions.baselineClaimProbability);
  const claimProbFactor = baseClaimProb > EPSILON ? claimProb / baseClaimProb : claimProb;
  const horizonClaimants =
    baselineClaimants * (Math.max(1, days) / baselinePeriodDays) * claimProbFactor;

  // The avg measured grant, used as the per-claimant grant for the BASELINE
  // (ungated, flat) shape. Other policies scale this by their nominal-grant
  // ratio so the anchor stays the real average while policy shape still moves
  // cost (a $10 grant costs ~2× a $5 grant, etc.).
  const avgGrant = Math.max(0, finite(assumptions.avgBonusUsd));
  const baselineNominal = Math.max(EPSILON, BASELINE_GRANT_USD);

  const perSegment: PerSegment[] = SEGMENTS.map((seg) => {
    const segFrac = mix[seg.id];
    const grossSegClaimants = horizonClaimants * segFrac;

    // Per-claimant grant this segment receives, clamped to the lifetime cap.
    // Scale the policy's per-segment grant against the baseline nominal so the
    // real avg-grant anchor flows through (segGrant == avgGrant for the baseline
    // shape, proportionally more/less for a richer/leaner policy).
    const policyGrant = grantForSegment(grant, seg.id);
    const segGrant = avgGrant * safeDiv(policyGrant, baselineNominal);

    // Deposit gate: only the paid share of this segment actually receives the
    // grant. FTD cohorts pass in full; non-FTD only at the retention floor;
    // abuse barely passes. Ungated → 1.0 for everyone.
    const paidShare = paidShareUnderGate(grant, seg.id, gateElasticity);
    const paidSegClaimants = grossSegClaimants * paidShare;

    // Per-claim PAID grant = the segment grant (cap already applied). Breakage
    // does NOT reduce cost (the grant is still AWARDED/credited) — it reduces
    // the wager that backs downstream retention (handled below). House outflow.
    const segBonusCost = paidSegClaimants * segGrant;

    // Abuse leakage: the abusive share of THIS segment's PAID grant, net of
    // capture (the deposit gate / tiering structurally prevents most of it).
    // The abuse cohort carries the full baseline abuse share; other segments a
    // small fraction. Monotone-decreasing in gate strength.
    const segAbuseShare =
      seg.id === "multi_account_abuse" ? Math.max(abuseShare, 0) : abuseShare * 0.25;
    const segAbuseLeakage = segBonusCost * clamp01(segAbuseShare) * (1 - capture);

    // Retained revenue: only LEGIT (non-abusive, non-broken) grant to users who
    // generate downstream play can retain. The retention BASE is strongest for
    // FTD cohorts (they deposit and wager); engaged-no-deposit retains a little
    // (free play converts some); dormant/abuse retain ~nothing. Reduced by
    // conversion lost to a deposit gate's friction.
    const legitShare = clamp01(1 - clamp01(segAbuseShare));
    const legitGrant = segBonusCost * legitShare * (1 - breakage);
    const segRetentionWeight = retentionWeightForSegment(seg.id);
    const segRetained =
      legitGrant * retentionUplift * segRetentionWeight * ftdFactor * (1 - convLoss);

    // NGR contribution, House-POV: downstream GGR proxy − grant cost. The
    // modeled downstream accretion the grant generates is the retained revenue.
    const segNgr = segRetained - segBonusCost;

    return {
      segment: seg.id,
      label: seg.label,
      claimants: finite(paidSegClaimants),
      bonusCost: finite(segBonusCost),
      abuseLeakage: finite(segAbuseLeakage),
      retainedRevenue: finite(segRetained),
      ngrImpact: finite(segNgr),
      effectiveCapUsd: finite(segGrant),
    };
  });

  // Aggregate.
  const bonusCost = perSegment.reduce((a, s) => a + s.bonusCost, 0);
  const abuseLeakage = perSegment.reduce((a, s) => a + s.abuseLeakage, 0);
  const retainedRevenue = perSegment.reduce((a, s) => a + s.retainedRevenue, 0);

  // NGR = downstream GGR proxy − bonusCost. House-POV: positive when retention
  // beats cost.
  const ngrImpact = retainedRevenue - bonusCost;

  // Net house P&L attributable to the program = retained − cost − abuseLeakage.
  const marginImpact = retainedRevenue - bonusCost - abuseLeakage;
  const netLoss = Math.max(0, -marginImpact);

  const friction = frictionScore(grant);

  const confidenceBand = {
    low: bonusCost * (1 - CONFIDENCE_BAND_SPREAD),
    mid: bonusCost,
    high: bonusCost * (1 + CONFIDENCE_BAND_SPREAD),
  };

  // savings vs baseline are filled in by `simulateSet` (which knows the baseline
  // result). Here we return them as 0; the daily series is built against this
  // scenario's own cost.
  const dailySeries = buildDailySeries(grant, days, {
    bonusCost,
    abuseLeakage,
    savingsVsBaselineTotal: 0,
  });

  return {
    scenarioId: scenario.id,
    bonusCost: finite(bonusCost),
    marginImpact: finite(marginImpact),
    netLoss: finite(netLoss),
    savingsVsBaseline: 0,
    netSavingsVsBaseline: 0,
    abuseLeakage: finite(abuseLeakage),
    retainedRevenue: finite(retainedRevenue),
    ngrImpact: finite(ngrImpact),
    frictionScore: finite(friction),
    confidenceBand: {
      low: finite(confidenceBand.low),
      mid: finite(confidenceBand.mid),
      high: finite(confidenceBand.high),
    },
    perSegment,
    dailySeries,
  };
}

/**
 * Modeled downstream-retention weight by segment (0-1). FTD cohorts carry the
 * full retention base (they deposit + wager); engaged-no-deposit a fraction
 * (free play converts some); dormant + abuse ~none. Pure, deterministic.
 */
export function retentionWeightForSegment(segmentId: SegmentId): number {
  switch (segmentId) {
    case "ftd_high_value":
      return 1;
    case "ftd_low_value":
      return 0.6;
    case "engaged_no_deposit":
      return 0.2;
    case "dormant_no_deposit":
      return 0.03;
    case "multi_account_abuse":
      return 0;
  }
}

/**
 * The daily-pacing FRONT-LOAD factor a grant rule implies: instant (flat /
 * deposit-gated) grants land with the daily signup inflow (flat); tiered /
 * level-up grants accrue as users play (back-loaded). The signup mapping of a
 * grant → the generic pacing number the shared `buildDailySeries` consumes.
 */
export function grantFrontload(grant: GrantRule): number {
  return grant.kind === "tiered_levelup" ? TIERED_GRANT_FRONTLOAD : INSTANT_GRANT_FRONTLOAD;
}

/**
 * Deterministic daily spread of a horizon total across `days`, using a pacing
 * curve (flat for instant grants, back-loaded for tiered) that integrates
 * EXACTLY to the supplied totals (no drift). Accumulates `cumulativeCost`.
 *
 * Thin grant-aware wrapper over the shared `buildDailySeries` (which takes the
 * front-load as a plain number) — kept with the grant signature so `simulate`
 * and the engine self-checks call it unchanged.
 */
export function buildDailySeries(
  grant: GrantRule,
  days: number,
  totals: { bonusCost: number; abuseLeakage: number; savingsVsBaselineTotal: number },
): DailyPoint[] {
  return buildDailySeriesGeneric(grantFrontload(grant), days, totals);
}

/**
 * Run a SET of scenarios and patch in savings-vs-baseline (gross + net) and the
 * daily savings series relative to the designated baseline scenario.
 *
 * When `anchorBaselineCostUsd` is supplied (the REAL production total grant
 * cost), the whole set is uniformly scaled so the BASELINE scenario's projected
 * cost equals that anchor EXACTLY — every view then reads the real baseline, and
 * other scenarios stay coherent fractions/multiples of it.
 *
 * Thin grant-aware wrapper over the shared, reward-agnostic `simulateSet`: it
 * supplies signup's pure `simulate` + the grant→front-load pacing resolver and
 * preserves the 5-arg signature so the live page and the engine self-checks call
 * it unchanged.
 */
export function simulateSet(
  scenarios: ScenarioConfig[],
  assumptions: Assumptions,
  window: { days: number },
  baselineId?: string,
  anchorBaselineCostUsd?: number | null,
): SimulationResult[] {
  return simulateSetGeneric(scenarios, assumptions, window, simulate, {
    baselineId,
    anchorBaselineCostUsd,
    pacingFrontload: (sc) => grantFrontload(sc.grant),
  });
}
