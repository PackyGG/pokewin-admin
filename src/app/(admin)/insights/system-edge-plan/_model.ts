/**
 * _model.ts — the PURE, serializable projection model for the System Edge Plan.
 *
 * No DB, no React, no side effects — every input and output is a primitive (or
 * a plain object of primitives), so this module is safe to import from BOTH the
 * server page (to seed the baseline) and the `"use client"` planner (to run the
 * what-if projection in a `useMemo` on every slider change). It mirrors the
 * dep-free style of `src/lib/metrics/formulas.ts` and
 * `src/app/(admin)/insights/edge-calc/math.ts`.
 *
 * ─── What this models ───────────────────────────────────────────────────────
 *
 * A read-only PLANNING tool. The owner tunes the reward-system levers and sees
 * the PROJECTED house profit at the planned config, plus the DELTA (savings /
 * extra cost) vs the CURRENT real config. It NEVER writes live data — the levers
 * are client-side what-ifs feeding this pure projection.
 *
 * ─── The canonical identity (house POV, per CLAUDE.md + the metrics layer) ──
 *
 *   GGR  = houseEdge × wager                 (gaming-only gross margin)
 *   NGR  = GGR − Σ(reward-lever costs)        (profit after house-funded giveaways)
 *
 * This is the SAME GGR/NGR shape the canonical `@/lib/metrics/formulas.ts`
 * encodes (`ggr = wager − gamingPayout`; `houseEdge = GGR / wager`, so
 * `GGR = houseEdge × wager`; `ngr = GGR − rewardCost`). The reward-cost side is
 * itemized per lever so each lever's contribution — and the effect of tuning it
 * — is explicit.
 *
 * ─── Grounded on REAL production numbers (NEVER invented) ───────────────────
 *
 * The CURRENT config + the anchors all come from real data, read at request
 * time (see `_baseline.ts`):
 *   • wager / GGR / empirical house edge ← `getWindowMetrics` (canonical scope).
 *   • per-lever reward cost ← `sumLedgerTypes` over the real ledger type per
 *     lever (rakeback_claim, affiliate_claim + affiliate_leaderboard_prize,
 *     deposit_bonus, race_prize), under the same canonical customer scope.
 *   • rakeback per-cadence rates ← real `rakeback_config` (getRakebackConfigs).
 *   • affiliate per-tier rates ← real `affiliate_level_configs`
 *     (getAffiliateLevelConfigs).
 *
 * Every lever's "current" value is its REAL value; the projection scales the
 * real baseline by the ratio (planned ÷ current) so the model is anchored to
 * actual production volume rather than a synthetic forecast. When a lever has no
 * direct rate knob in the admin (deposit bonus, raffle, upgrader weighting), the
 * lever is a proportional MULTIPLIER on the real cost — clearly labeled as such
 * in the UI — never a fabricated absolute rate.
 */

// ─── Affiliate tiers (the real ladder, collapsed onto a planner shape) ──────

/** One affiliate commission tier as the planner tunes it. */
export type AffiliateTierLever = {
  /** Ladder level (1 … N) from `affiliate_level_configs.level`. */
  level: number;
  /** Display label (e.g. "Level 5"). */
  label: string;
  /** CURRENT commission rate (decimal fraction, e.g. 0.05 = 5%). The real rate. */
  currentRate: number;
  /** Cumulative referred-wager threshold to reach this tier (USD). */
  threshold: number;
};

// ─── Rakeback cadences (the real config, one row per cadence) ───────────────

export type RakebackCadenceId = "daily" | "weekly" | "monthly";

/** One rakeback cadence as the planner tunes it. */
export type RakebackCadenceLever = {
  /** Cadence type from `rakeback_config.type`. */
  cadence: RakebackCadenceId;
  /** Display label from `rakeback_config.display_name`. */
  label: string;
  /** CURRENT rate (decimal fraction, e.g. 0.0025 = 0.25%). The real rate. */
  currentRate: number;
  /** Whether this cadence is enabled (`rakeback_config.enabled`). */
  enabled: boolean;
};

// ─── The serializable baseline (REAL current config + anchors) ──────────────

/**
 * Everything the planner needs to seed the levers + run the projection, all
 * REAL and serializable. Assembled server-side in `_baseline.ts`.
 */
export type SystemEdgeBaseline = {
  /** Human label for the anchor window (e.g. "Last 30 days"). */
  periodLabel: string;
  /** Day-span the window covers (lifetime is bounded). Drives monthly/annual scaling. */
  periodDays: number;

  // ── Gaming anchors (real, canonical scope) ──
  /** Real Σ wager over the window (pack + battle + upgrader), house-POV. */
  wager: number;
  /** Real gaming payout returned to users over the window. */
  gamingPayout: number;
  /** Real GGR = wager − gamingPayout. */
  ggr: number;
  /**
   * Real empirical house edge as a 0..1 fraction (GGR / wager), or null below
   * MIN_SAMPLE. When null the planner falls back to deriving edge from
   * GGR / wager directly (and flags low confidence).
   */
  houseEdge: number | null;
  /** Settled bets in the window (the empirical-edge sample size). */
  bets: number;

  // ── Per-lever REAL reward costs over the window ──
  /** Real Σ |rakeback_claim| over the window. */
  rakebackCost: number;
  /** Real Σ |affiliate_claim| + |affiliate_leaderboard_prize| over the window. */
  affiliateCost: number;
  /** Real Σ |deposit_bonus| over the window. */
  depositBonusCost: number;
  /** Real Σ |race_prize| over the window. */
  raceCost: number;
  /**
   * Real Σ of every OTHER house-funded reward leg over the window
   * (gift_card_redeemed, promo_code_redeemed, waitlist_prize,
   * balance_reward_claim, manual vouchers + counted adjustments, net rain).
   * Held fixed by the planner (no lever) so the profit math reconciles with the
   * canonical NGR — surfaced as an informational "other reward cost" line.
   */
  otherRewardCost: number;

  // ── Real lever configs (seed the sliders) ──
  /** Real rakeback cadences from `rakeback_config`. */
  rakebackCadences: RakebackCadenceLever[];
  /** Real affiliate tiers from `affiliate_level_configs`. */
  affiliateTiers: AffiliateTierLever[];
  /**
   * Blended affiliate commission rate over the window = total commission ÷
   * referred wager, when both are known; else null. Used only as an
   * informational note (the per-tier rates drive the projection).
   */
  affiliateBlendedRate: number | null;
  /**
   * CURRENT upgrader→rakeback weighting (real = 1.0 = 100%, per the discovery:
   * upgrader wager contributes to rakeback at full weight, unweighted). The
   * lever lets the owner model down-weighting it; at 1.0 it is neutral.
   */
  upgraderRakebackWeight: number;
  /**
   * Real Σ upgrader wager over the window (the slice the upgrader→rakeback
   * weight lever applies to). 0 on a pre-upgrader DB. Used to size how much of
   * the rakeback cost the weighting lever can move.
   */
  upgraderWager: number;
  /**
   * Real raffle ticket rate (tickets earned per $X wagered) when the admin
   * exposes it; otherwise null. Per the discovery this rate lives in the MAIN
   * game backend (not this admin repo), so when null the raffle lever is a
   * proportional cost multiplier rather than an absolute rate. Reserved for a
   * future wire-up if the rate becomes readable.
   */
  raffleTicketRate: number | null;
  /** Real Σ raffle prize cost over the window (reconstructed), or 0 when unknown. */
  raffleCost: number;
};

// ─── The planned (tunable) lever values ─────────────────────────────────────

/**
 * The planner's mutable state — every lever the owner can tune. All values are
 * absolute (not deltas) so the state round-trips cleanly. Seeded from the
 * baseline's REAL values via `defaultLevers(baseline)`.
 */
export type PlannedLevers = {
  /**
   * Planned house edge as a 0..1 fraction. Seeded from the real empirical edge.
   * Drives projected GGR = edge × wager.
   */
  houseEdge: number;
  /** Planned upgrader→rakeback weight (0..1). Seeded from real (1.0). */
  upgraderRakebackWeight: number;
  /** Planned rakeback rate per cadence (decimal fraction), keyed by cadence. */
  rakebackRates: Record<RakebackCadenceId, number>;
  /** Planned affiliate commission rate per tier level (decimal fraction). */
  affiliateRates: Record<number, number>;
  /**
   * Remove the 1× wager requirement on affiliate commission. Per the discovery
   * the requirement is IMPLICIT (commission vests on referred wager); removing
   * it widens the commission base, modeled as a cost uplift (more referrals
   * qualify). Default false (keep the requirement = current behavior).
   */
  removeAffiliateWagerReq: boolean;
  /**
   * Deposit-bonus spend multiplier (1.0 = current real spend). No single % knob
   * exists in the admin (the cap is backend-enforced), so the planner scales the
   * real deposit-bonus cost proportionally.
   */
  depositBonusMult: number;
  /**
   * Raffle ticket-rate multiplier (1.0 = current). A HIGHER ticket rate (more
   * tickets per $) means more prizes claimed → higher cost; the multiplier
   * scales the real raffle cost proportionally.
   */
  raffleTicketRateMult: number;
};

/**
 * Effect of removing the 1× wager requirement on the affiliate commission base.
 * Per the discovery, the requirement implicitly filters churned / no-wager
 * referrals out of the commission base; removing it widens the base. Modeled as
 * a proportional uplift to the affiliate cost. Conservative single-point
 * assumption (NOT a fabricated rate) — clearly labeled in the UI as a what-if.
 */
export const REMOVE_WAGER_REQ_COST_UPLIFT = 0.15 as const;

/** Seed the planner's lever state from the REAL baseline (current = planned at open). */
export function defaultLevers(baseline: SystemEdgeBaseline): PlannedLevers {
  const rakebackRates: Record<RakebackCadenceId, number> = {
    daily: 0,
    weekly: 0,
    monthly: 0,
  };
  for (const c of baseline.rakebackCadences) {
    rakebackRates[c.cadence] = c.currentRate;
  }
  const affiliateRates: Record<number, number> = {};
  for (const t of baseline.affiliateTiers) {
    affiliateRates[t.level] = t.currentRate;
  }
  return {
    houseEdge: effectiveBaselineEdge(baseline),
    upgraderRakebackWeight: baseline.upgraderRakebackWeight,
    rakebackRates,
    affiliateRates,
    removeAffiliateWagerReq: false,
    depositBonusMult: 1,
    raffleTicketRateMult: 1,
  };
}

/**
 * The house edge to seed the planner with: the real empirical edge when the
 * sample is large enough, else derived from GGR / wager (the same quantity,
 * just below the sample-confidence gate). Clamped to a sane 0..1 band.
 */
export function effectiveBaselineEdge(baseline: SystemEdgeBaseline): number {
  const raw =
    baseline.houseEdge != null
      ? baseline.houseEdge
      : baseline.wager > 0
        ? baseline.ggr / baseline.wager
        : 0;
  return clamp(raw, 0, 1);
}

// ─── The projection ──────────────────────────────────────────────────────────

/** A single lever's current-vs-planned cost contribution. */
export type LeverProjection = {
  /** Stable key. */
  key: string;
  /** Display label. */
  label: string;
  /** Real current cost over the window (house outflow). */
  currentCost: number;
  /** Projected cost over the window at the planned config. */
  plannedCost: number;
  /** plannedCost − currentCost (positive = MORE house cost = worse). */
  deltaCost: number;
};

export type EdgePlanProjection = {
  // ── Current (real) ──
  currentWager: number;
  currentEdge: number;
  currentGgr: number;
  currentRewardCost: number;
  currentNgr: number;

  // ── Planned (what-if) ──
  plannedWager: number;
  plannedEdge: number;
  plannedGgr: number;
  plannedRewardCost: number;
  plannedNgr: number;

  // ── Deltas (planned − current; for profit, positive = MORE house profit) ──
  /** plannedGgr − currentGgr. */
  ggrDelta: number;
  /** plannedRewardCost − currentRewardCost (positive = more cost). */
  rewardCostDelta: number;
  /**
   * plannedNgr − currentNgr. THE HEADLINE. Positive = the planned config makes
   * the house MORE money over the window; negative = it costs the house.
   */
  profitDelta: number;

  // ── Annualized headline (window profit delta scaled to 30d / 365d) ──
  /** profitDelta scaled to a 30-day month. */
  monthlyProfitDelta: number;
  /** profitDelta scaled to a 365-day year. */
  annualProfitDelta: number;

  // ── Per-lever cost breakdown (for the comparison table / chart) ──
  levers: LeverProjection[];
};

/**
 * Run the full current-vs-planned projection. PURE — given the real baseline +
 * the planned levers, returns every figure the UI renders. No DB, no clock.
 *
 * Model:
 *   plannedGGR  = plannedEdge × wager                  (wager held at real volume)
 *   leverCost_i = realCost_i × (plannedRate_i / currentRate_i)   (proportional)
 *   plannedNGR  = plannedGGR − Σ leverCost_i − otherRewardCost
 *   profitDelta = plannedNGR − currentNGR
 *
 * Wager is held at the REAL observed volume (no elasticity guess) so the model
 * stays grounded and the deltas are pure config effects — the honest, defensible
 * planning number. (Elasticity is a separate behavioral assumption the existing
 * per-reward forecast engine models; this unified planner deliberately reports
 * the direct config impact at constant volume.)
 */
export function projectEdgePlan(
  baseline: SystemEdgeBaseline,
  planned: PlannedLevers,
): EdgePlanProjection {
  const wager = baseline.wager;
  const currentEdge = effectiveBaselineEdge(baseline);
  const plannedEdge = clamp(planned.houseEdge, 0, 1);

  const currentGgr = currentEdge * wager;
  const plannedGgr = plannedEdge * wager;

  // ── Rakeback ──
  // Real rakeback cost is the realized Σ over all cadences. We scale it by the
  // ratio of the planned blended rate to the current blended rate, where the
  // blend is weighted by each cadence's share of the current cost (cadences
  // with more realized cost dominate). The upgrader→rakeback weight further
  // scales the upgrader slice of wager's contribution.
  const rakebackProjection = projectRakeback(baseline, planned);

  // ── Affiliate ──
  const affiliateProjection = projectAffiliate(baseline, planned);

  // ── Deposit bonus (proportional multiplier on real cost) ──
  const depositBonusCurrent = baseline.depositBonusCost;
  const depositBonusPlanned =
    depositBonusCurrent * Math.max(0, planned.depositBonusMult);

  // ── Race (held fixed — not a tunable lever in this planner, but surfaced) ──
  const raceCurrent = baseline.raceCost;
  const racePlanned = raceCurrent;

  // ── Raffle (proportional multiplier on real cost) ──
  const raffleCurrent = baseline.raffleCost;
  const rafflePlanned = raffleCurrent * Math.max(0, planned.raffleTicketRateMult);

  const levers: LeverProjection[] = [
    {
      key: "rakeback",
      label: "Rakeback",
      currentCost: rakebackProjection.current,
      plannedCost: rakebackProjection.planned,
      deltaCost: rakebackProjection.planned - rakebackProjection.current,
    },
    {
      key: "affiliate",
      label: "Affiliate commission",
      currentCost: affiliateProjection.current,
      plannedCost: affiliateProjection.planned,
      deltaCost: affiliateProjection.planned - affiliateProjection.current,
    },
    {
      key: "deposit-bonus",
      label: "Deposit bonus",
      currentCost: depositBonusCurrent,
      plannedCost: depositBonusPlanned,
      deltaCost: depositBonusPlanned - depositBonusCurrent,
    },
    {
      key: "raffle",
      label: "Raffle prizes",
      currentCost: raffleCurrent,
      plannedCost: rafflePlanned,
      deltaCost: rafflePlanned - raffleCurrent,
    },
    {
      key: "race",
      label: "Race prizes",
      currentCost: raceCurrent,
      plannedCost: racePlanned,
      deltaCost: racePlanned - raceCurrent,
    },
    {
      key: "other",
      label: "Other reward cost",
      currentCost: baseline.otherRewardCost,
      plannedCost: baseline.otherRewardCost,
      deltaCost: 0,
    },
  ];

  const currentRewardCost = levers.reduce((s, l) => s + l.currentCost, 0);
  const plannedRewardCost = levers.reduce((s, l) => s + l.plannedCost, 0);

  const currentNgr = currentGgr - currentRewardCost;
  const plannedNgr = plannedGgr - plannedRewardCost;

  const profitDelta = plannedNgr - currentNgr;
  const days = Math.max(1, baseline.periodDays);
  const perDay = profitDelta / days;

  return {
    currentWager: wager,
    currentEdge,
    currentGgr,
    currentRewardCost,
    currentNgr,

    plannedWager: wager,
    plannedEdge,
    plannedGgr,
    plannedRewardCost,
    plannedNgr,

    ggrDelta: plannedGgr - currentGgr,
    rewardCostDelta: plannedRewardCost - currentRewardCost,
    profitDelta,

    monthlyProfitDelta: perDay * 30,
    annualProfitDelta: perDay * 365,

    levers,
  };
}

// ─── Per-lever projection helpers ────────────────────────────────────────────

/**
 * Rakeback projection. The realized rakeback cost scales with the blended rate
 * (cost-weighted across cadences) AND with the upgrader→rakeback weight (which
 * scales how much of the upgrader-wager slice still accrues rakeback).
 *
 * Blended-rate scaling:
 *   plannedBlend / currentBlend, where each blend is Σ(rate_c · w_c) and w_c is
 *   cadence c's share of the current realized rakeback cost (so disabled / zero-
 *   cost cadences carry no weight). When the current blend is 0 the ratio is 1.
 *
 * Upgrader-weight scaling:
 *   The upgrader slice of wager = upgraderWager / wager. Down-weighting it from
 *   1.0 to w removes (1 − w) of that slice's rakeback contribution:
 *     weightFactor = 1 − upgraderShare · (1 − plannedWeight)
 *   (At plannedWeight = currentWeight = 1.0 this is 1.0 → neutral.)
 */
function projectRakeback(
  baseline: SystemEdgeBaseline,
  planned: PlannedLevers,
): { current: number; planned: number } {
  const current = baseline.rakebackCost;
  if (current <= 0) return { current: 0, planned: 0 };

  // Cost-weight per cadence (share of realized cost). When per-cadence realized
  // cost isn't separable we fall back to an even split across enabled cadences.
  const cadences = baseline.rakebackCadences;
  const currentBlend = cadences.reduce(
    (s, c) => s + c.currentRate * cadenceWeight(c, cadences),
    0,
  );
  const plannedBlend = cadences.reduce(
    (s, c) =>
      s +
      Math.max(0, planned.rakebackRates[c.cadence] ?? c.currentRate) *
        cadenceWeight(c, cadences),
    0,
  );
  const rateRatio = currentBlend > 0 ? plannedBlend / currentBlend : 1;

  // Upgrader-weight factor.
  const upgraderShare =
    baseline.wager > 0
      ? clamp(baseline.upgraderWager / baseline.wager, 0, 1)
      : 0;
  const plannedWeight = clamp(planned.upgraderRakebackWeight, 0, 1);
  const weightFactor = 1 - upgraderShare * (1 - plannedWeight);

  return {
    current,
    planned: Math.max(0, current * rateRatio * weightFactor),
  };
}

/** Even cost-weight across enabled cadences (used to blend per-cadence rates). */
function cadenceWeight(
  cadence: RakebackCadenceLever,
  all: RakebackCadenceLever[],
): number {
  const enabled = all.filter((c) => c.enabled);
  if (enabled.length === 0) return cadence.enabled ? 1 : 0;
  return cadence.enabled ? 1 / enabled.length : 0;
}

/**
 * Affiliate projection. The realized commission cost scales with the planned
 * blended commission rate vs the current blended rate, where the blend is the
 * simple average of the per-tier rates (the planner exposes per-tier rates; the
 * real per-affiliate wager mix per tier is not separable from the rollup, so an
 * even tier blend is the honest proportional scaler). Removing the 1× wager
 * requirement widens the commission base by a labeled uplift.
 */
function projectAffiliate(
  baseline: SystemEdgeBaseline,
  planned: PlannedLevers,
): { current: number; planned: number } {
  const current = baseline.affiliateCost;
  if (current <= 0) {
    // No realized commission to scale — the wager-req toggle still has nothing
    // to act on, so the projection stays 0.
    return { current: 0, planned: 0 };
  }

  const tiers = baseline.affiliateTiers;
  const currentBlend = avg(tiers.map((t) => t.currentRate));
  const plannedBlend = avg(
    tiers.map((t) => Math.max(0, planned.affiliateRates[t.level] ?? t.currentRate)),
  );
  const rateRatio = currentBlend > 0 ? plannedBlend / currentBlend : 1;

  const reqUplift = planned.removeAffiliateWagerReq
    ? 1 + REMOVE_WAGER_REQ_COST_UPLIFT
    : 1;

  return {
    current,
    planned: Math.max(0, current * rateRatio * reqUplift),
  };
}

// ─── Small pure helpers ──────────────────────────────────────────────────────

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
