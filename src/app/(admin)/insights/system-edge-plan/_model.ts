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
 * A read-only PLANNING tool: a "full edge / reward system" the owner can play
 * future updates with. They tune EVERY system lever and see the PROJECTED house
 * profit at the planned config, plus the DELTA (savings / extra cost) vs the
 * CURRENT real config — over the window, and extrapolated to a month / a year.
 * It NEVER writes live data; the levers are client-side what-ifs feeding this
 * pure projection.
 *
 * ─── The canonical identity (house POV, per CLAUDE.md + the metrics layer) ──
 *
 *   GGR_type = edge_type × wager_type            (per game type)
 *   GGR      = Σ GGR_type                         (packs + battles + upgrader)
 *   NGR      = GGR − Σ(reward-lever costs)        (profit after house giveaways)
 *
 * This is the SAME GGR/NGR shape the canonical `@/lib/metrics/formulas.ts`
 * encodes (`ggr = wager − gamingPayout`; `houseEdge = GGR / wager`, so
 * `GGR = houseEdge × wager`; `ngr = GGR − rewardCost`), split per game type on
 * the GGR side and itemized per lever on the reward-cost side so each lever's
 * contribution — and the effect of tuning it — is explicit.
 *
 * ─── Grounded on REAL production numbers (NEVER invented) ───────────────────
 *
 * The CURRENT config + the anchors all come from real data, read at request
 * time (see `_baseline.ts`):
 *   • per-type wager / payout / empirical edge ← a per-type split of the
 *     canonical `getGamingLegs` reads (packs vs battles vs upgrader) under the
 *     SAME canonical real-customer, borrow-corrected scope — so the three types
 *     sum to the canonical headline GGR by construction.
 *   • per-lever reward cost ← `sumLedgerTypes` over the real ledger type per
 *     lever (rakeback_claim, affiliate_claim + affiliate_leaderboard_prize,
 *     deposit_bonus, race_prize), the canonical net rain, the daily-pack
 *     giveaway, and the signup balance-reward cost — all under the same scope.
 *   • rakeback per-cadence rates ← real `rakeback_config` (getRakebackConfigs).
 *   • affiliate per-tier rates ← real `affiliate_level_configs`
 *     (getAffiliateLevelConfigs).
 *
 * Every lever's "current" value is its REAL value; the projection scales the
 * real baseline so the model is anchored to actual production volume rather than
 * a synthetic forecast. Wager is HELD at the observed volume so the deltas are
 * pure config effects (the honest, defensible planning number). Where a lever
 * has no direct rate knob in the admin (deposit-bonus cap, raffle ticket rate,
 * daily-pack frequency), the lever scales the real realized cost proportionally
 * — clearly LABELED as such in the UI — never a fabricated absolute rate.
 */

// ─── Game types (per-type edge — the owner's #1 ask) ────────────────────────

export type GameTypeId = "packs" | "battles" | "upgrader";

export const GAME_TYPE_IDS: readonly GameTypeId[] = [
  "packs",
  "battles",
  "upgrader",
] as const;

export function gameTypeLabel(t: GameTypeId): string {
  return t === "packs" ? "Packs" : t === "battles" ? "Battles" : "Upgrader";
}

/** One game type's REAL gaming anchors over the window (house POV). */
export type GameTypeBaseline = {
  type: GameTypeId;
  /** Real Σ wager for this type over the window (borrow-corrected, real customers). */
  wager: number;
  /** Real Σ gaming payout returned to users for this type. */
  payout: number;
  /** Real GGR = wager − payout for this type. */
  ggr: number;
  /**
   * Real empirical house edge as a 0..1 fraction (GGR / wager), or null when
   * below MIN_SAMPLE / no wager. The lever seeds from this when present, else
   * from GGR/wager directly (flagged low-confidence in the UI).
   */
  edge: number | null;
  /** Settled bets for this type (the empirical-edge sample size). */
  bets: number;
  /**
   * False when this type's figures are not separable from real data in this
   * snapshot (e.g. upgrader on a pre-upgrader DB). The lever is still SURFACED
   * but clearly labeled "not yet wired" and contributes 0.
   */
  dataAvailable: boolean;
};

// ─── Affiliate tiers (the real ladder) ──────────────────────────────────────

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

  // ── Gaming anchors, per type (real, canonical scope; sum to headline GGR) ──
  /** Per-type wager / payout / edge / bets. packs + battles + upgrader. */
  gameTypes: GameTypeBaseline[];
  /** Real Σ wager over the window across all types (= Σ gameTypes.wager). */
  wager: number;
  /** Real Σ gaming payout over the window across all types. */
  gamingPayout: number;
  /** Real GGR = wager − gamingPayout. */
  ggr: number;
  /** Real blended empirical house edge as a 0..1 fraction, or null below sample. */
  houseEdge: number | null;
  /** Settled bets across all types (sample size for the blended edge). */
  bets: number;

  // ── Per-lever REAL reward costs over the window ──
  /** Real Σ |rakeback_claim| over the window. */
  rakebackCost: number;
  /** Real Σ |affiliate_claim| + |affiliate_leaderboard_prize| over the window. */
  affiliateCost: number;
  /** Real Σ |deposit_bonus| over the window. */
  depositBonusCost: number;
  /**
   * Real Σ |race_prize| over the window — the on-site competitive RACES cost
   * (the `race_prize` ledger type). This is the cash prize cost of races, NOT
   * raffles. It is a ledger type and therefore already inside the canonical NGR
   * reward cost.
   */
  raceCost: number;
  /**
   * Real reconstructed RAFFLE prize cost over the window — the on-site raffles
   * where users earn tickets per $X wagered. Raffles pay out pack/card ITEMS
   * (a `prizes` JSON array on each `raffles` row), NOT a ledger money leg, so
   * the cost is RECONSTRUCTED by valuing each completed raffle's prize lines at
   * the live pack/card price (the canonical `getRaffleForecastBaseline` read).
   * Because it is NOT a ledger type it is NOT inside the canonical NGR reward
   * cost — the planner adds it on top as its own line (exactly like the
   * daily-pack giveaway), so there is NO double-count with races.
   */
  raffleCost: number;
  /** Real daily / free-pack giveaway cost (Σ value_at_obtained of cards out). */
  dailyPacksCost: number;
  /** Real signup balance-reward cost (Σ |balance_reward_claim| for the cohort). */
  signupPacksCost: number;
  /**
   * Real house slice of rain over the window = max(0, Σ|rain_win| − Σ|rain_tip|)
   * — the owner-confirmed net rain model from the canonical metric layer.
   */
  rainCost: number;
  /**
   * Real motha (founder giveaway account) outflow over the window — the same
   * `creator_tip` + `battle_sponsorship` + `rain_tips` channels modeled by
   * `getMothaGiveawayOverview`. These rows are canonically RESIDUAL / WAGER /
   * rain-funding (so NOT inside the canonical NGR reward cost — no
   * double-count with `otherRewardCost`), but the founder funded them as
   * giveaways, so the planner surfaces them as their own named line. Held
   * fixed by the planner (no lever — same shape as `otherRewardCost`).
   */
  mothaCost: number;
  /**
   * Real Σ of every OTHER house-funded reward leg over the window that this
   * planner does NOT expose as its own lever (gift_card_redeemed,
   * promo_code_redeemed, waitlist_prize, manual vouchers + counted
   * adjustments). Held fixed by the planner so the profit math reconciles with
   * the canonical NGR — surfaced as an informational "other reward cost" line.
   */
  otherRewardCost: number;

  // ── Real lever configs (seed the sliders) ──
  /** Real rakeback cadences from `rakeback_config`. */
  rakebackCadences: RakebackCadenceLever[];
  /** Real affiliate tiers from `affiliate_level_configs`. */
  affiliateTiers: AffiliateTierLever[];
  /**
   * Blended affiliate commission rate over the window = total commission ÷
   * referred wager, when both are known; else null. Informational note only
   * (the per-tier rates drive the projection).
   */
  affiliateBlendedRate: number | null;

  // ── Real signup-bonus anchors (for the signup-pack lever readout) ──
  /**
   * Real measured average signup balance-reward grant (USD per claimant) over
   * the window, or null when there were no claims. The signup lever's "grant"
   * control seeds from this. NOT the $5 nominal constant — the live average.
   */
  signupAvgGrant: number | null;
  /** Real signup claimants in the window (drives the grant-lever cost scaling). */
  signupClaimants: number;

  // ── Real deposit-bonus anchors (for the deposit-bonus lever readouts) ──
  /**
   * Backend-enforced baseline deposit-bonus cap (USD per window) — the
   * empirically-anchored reference ($100, per the discovery). The cap is NOT
   * configurable in this admin; the lever models the proportional cost effect
   * of changing it. Informational + sizes the cap lever's reference point.
   */
  depositBonusCapUsd: number;
  /** Backend-enforced baseline deposit-bonus reset window (hours) — reference. */
  depositBonusWindowHours: number;
};

// ─── The planned (tunable) lever values ─────────────────────────────────────

/**
 * The planner's mutable state — every lever the owner can tune. All values are
 * absolute (not deltas) so the state round-trips cleanly. Seeded from the
 * baseline's REAL values via `defaultLevers(baseline)`.
 */
export type PlannedLevers = {
  // ── EDGE — separate per game type (packs / battles / upgrader) ──
  /** Planned house edge per game type as a 0..1 fraction. Seeds from real edge. */
  edges: Record<GameTypeId, number>;

  // ── RAKEBACK ──
  /** Planned rakeback rate per cadence (decimal fraction), keyed by cadence. */
  rakebackRates: Record<RakebackCadenceId, number>;
  /**
   * How much PACK + BATTLE wager counts toward rakeback (0..1). Real = 1.0
   * (full weight). Down-weighting shrinks the rakeback accrual from that slice.
   */
  rakebackPackBattleWeight: number;
  /**
   * How much UPGRADER wager counts toward rakeback (0..1). Real = 1.0 (full
   * weight, per the discovery). Down-weighting shrinks the upgrader slice's
   * rakeback contribution.
   */
  rakebackUpgraderWeight: number;
  /**
   * Instant rakeback-claim payout % (0..1). The fraction of accrued rakeback an
   * instant claim pays out immediately (the rest of the cadence accrual the
   * owner keeps). At 1.0 the instant option pays the full accrual (no effect);
   * BELOW 1.0 it pays a discounted lump that REDUCES the realized rakeback cost
   * across the adopting share. See `rakebackInstantAdoption`.
   */
  rakebackInstantPayoutPct: number;
  /**
   * Share of rakeback claimants who take the instant option (0..1). 0 = nobody
   * (instant lever has no effect); higher = the discount applies to more of the
   * realized cost. A behavioral planning assumption (clearly labeled).
   */
  rakebackInstantAdoption: number;

  // ── AFFILIATE ──
  /** Planned affiliate commission rate per tier level (decimal fraction). */
  affiliateRates: Record<number, number>;
  /**
   * Remove the 1× wager requirement on affiliate commission. Per the discovery
   * the requirement is IMPLICIT (commission vests on referred wager); removing
   * it widens the commission base, modeled as a cost uplift. Default false
   * (keep the requirement = current behavior). Clearly labeled what-if.
   */
  removeAffiliateWagerReq: boolean;

  // ── DEPOSIT BONUS — many settings (proportional cost effects) ──
  /** Match % multiplier (1.0 = current). Doubling the match ≈ doubles the cost. */
  depositBonusMatchMult: number;
  /**
   * Cap multiplier (1.0 = current cap). Raising the cap lets more bonus through
   * on the abusive / whale tail; a sub-linear scaler models the diminishing
   * extra cost (most claims are below cap).
   */
  depositBonusCapMult: number;
  /**
   * Min-deposit gate multiplier (1.0 = current). RAISING the min deposit filters
   * out small claimers → LOWER cost; a value < 1 means a lower gate (more
   * claimers → higher cost). Modeled as an inverse-ish eligibility scaler.
   */
  depositBonusMinDepositMult: number;
  /**
   * Wager-requirement multiplier (1.0 = current). A higher wager requirement
   * raises breakage (more bonus expires unwagered) → LOWER realized cost.
   */
  depositBonusWagerReqMult: number;

  // ── RACES — on-site competitive races (real race_prize cost) ──
  /** Prize-pool multiplier (1.0 = current). Cost scales ~linearly with the pool. */
  racePrizePoolMult: number;
  /** Draw / event-frequency multiplier (1.0 = current). More races ⇒ more prize cost. */
  raceFrequencyMult: number;
  /**
   * Entry-threshold multiplier (1.0 = current). A HIGHER entry bar (harder to
   * place) trims farming leakage → slightly LOWER cost; a lower bar loosens
   * entry → higher cost. Modeled as a mild proportional scaler.
   */
  raceEntryCostMult: number;

  // ── RAFFLES — on-site ticket raffles (real reconstructed prize cost) ──
  /** Prize-pool multiplier (1.0 = current). Cost scales ~linearly with the pool. */
  rafflePrizePoolMult: number;
  /** Draw-frequency multiplier (1.0 = current). More draws ⇒ more prize cost. */
  raffleFrequencyMult: number;
  /**
   * Ticket-rate / entry-cost multiplier (1.0 = current). A HIGHER ticket cost
   * (harder to enter) trims farming leakage → slightly LOWER cost; a lower cost
   * loosens entry → higher cost. Modeled as a mild proportional scaler.
   */
  raffleTicketCostMult: number;

  // ── DAILY PACKS — full lever (value + frequency) ──
  /** Card-value multiplier (1.0 = current). Richer daily packs ⇒ more cost. */
  dailyPacksValueMult: number;
  /** Frequency multiplier (1.0 = current). More frequent grants ⇒ more cost. */
  dailyPacksFrequencyMult: number;

  // ── SIGNUP PACKS — grant lever ──
  /**
   * Signup grant per claimant (USD). Seeds from the real measured average. Cost
   * scales linearly: claimants × grant.
   */
  signupGrantUsd: number;

  // ── RAIN ──
  /** Rain giveaway cost multiplier (1.0 = current net rain cost). */
  rainCostMult: number;
};

/**
 * Effect of removing the 1× wager requirement on the affiliate commission base.
 * Per the discovery, the requirement implicitly filters churned / no-wager
 * referrals out of the commission base; removing it widens the base. Modeled as
 * a proportional uplift to the affiliate cost. Conservative single-point
 * assumption (NOT a fabricated rate) — clearly labeled in the UI as a what-if.
 */
export const REMOVE_WAGER_REQ_COST_UPLIFT = 0.15 as const;

/**
 * How strongly raising the deposit-bonus CAP adds cost. Most claims sit below
 * the cap, so doubling the cap does NOT double the cost — only the slice that
 * was clipped at the old cap grows. A sub-linear exponent models that: extra
 * cost ∝ capMult^CAP_COST_EXPONENT. 0.45 ⇒ a 2× cap ≈ +37% cost (only the tail
 * that was clipped). Conservative, clearly-labeled planning assumption.
 */
export const DEPOSIT_BONUS_CAP_COST_EXPONENT = 0.45 as const;

/**
 * Daily-pack default card-value multiplier seed. The real value is the measured
 * giveaway cost; the lever scales it. (No separate constant needed — kept here
 * only to document that 1.0 is the real anchor.)
 */

// ─── Lever seeding ───────────────────────────────────────────────────────────

/** Seed the planner's lever state from the REAL baseline (current = planned at open). */
export function defaultLevers(baseline: SystemEdgeBaseline): PlannedLevers {
  const edges: Record<GameTypeId, number> = {
    packs: 0,
    battles: 0,
    upgrader: 0,
  };
  for (const g of baseline.gameTypes) {
    edges[g.type] = effectiveTypeEdge(g);
  }

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
    edges,

    rakebackRates,
    rakebackPackBattleWeight: 1,
    rakebackUpgraderWeight: 1,
    // Instant claim defaults to a no-op: pays the full accrual to nobody, so it
    // doesn't move the baseline until the owner dials it in.
    rakebackInstantPayoutPct: 1,
    rakebackInstantAdoption: 0,

    affiliateRates,
    removeAffiliateWagerReq: false,

    depositBonusMatchMult: 1,
    depositBonusCapMult: 1,
    depositBonusMinDepositMult: 1,
    depositBonusWagerReqMult: 1,

    racePrizePoolMult: 1,
    raceFrequencyMult: 1,
    raceEntryCostMult: 1,

    rafflePrizePoolMult: 1,
    raffleFrequencyMult: 1,
    raffleTicketCostMult: 1,

    dailyPacksValueMult: 1,
    dailyPacksFrequencyMult: 1,

    signupGrantUsd: baseline.signupAvgGrant ?? 0,

    rainCostMult: 1,
  };
}

/** Neutral lever defaults (every multiplier 1.0, no edge/rate, no toggles). */
function neutralLevers(): PlannedLevers {
  return {
    edges: { packs: 0, battles: 0, upgrader: 0 },
    rakebackRates: { daily: 0, weekly: 0, monthly: 0 },
    rakebackPackBattleWeight: 1,
    rakebackUpgraderWeight: 1,
    rakebackInstantPayoutPct: 1,
    rakebackInstantAdoption: 0,
    affiliateRates: {},
    removeAffiliateWagerReq: false,
    depositBonusMatchMult: 1,
    depositBonusCapMult: 1,
    depositBonusMinDepositMult: 1,
    depositBonusWagerReqMult: 1,
    racePrizePoolMult: 1,
    raceFrequencyMult: 1,
    raceEntryCostMult: 1,
    rafflePrizePoolMult: 1,
    raffleFrequencyMult: 1,
    raffleTicketCostMult: 1,
    dailyPacksValueMult: 1,
    dailyPacksFrequencyMult: 1,
    signupGrantUsd: 0,
    rainCostMult: 1,
  };
}

/**
 * Coerce arbitrary (de-serialized / persisted / hand-edited) input into a
 * COMPLETE, finite `PlannedLevers`. This is the single trust boundary for the
 * localStorage preset store: any missing key falls back to its neutral default
 * and any non-finite number is dropped, so a stale or corrupted payload can
 * never feed NaN / a missing lever into the pure projection. Pure + dep-free.
 */
export function sanitizeLevers(input: unknown): PlannedLevers {
  const base = neutralLevers();
  if (input == null || typeof input !== "object") return base;
  const src = input as Record<string, unknown>;

  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // Edges (0..1 per game type).
  if (src.edges != null && typeof src.edges === "object") {
    const e = src.edges as Record<string, unknown>;
    for (const t of GAME_TYPE_IDS) {
      base.edges[t] = clamp(num(e[t], base.edges[t]), 0, 1);
    }
  }

  // Rakeback per-cadence rates (0..1).
  if (src.rakebackRates != null && typeof src.rakebackRates === "object") {
    const r = src.rakebackRates as Record<string, unknown>;
    for (const c of ["daily", "weekly", "monthly"] as RakebackCadenceId[]) {
      base.rakebackRates[c] = clamp(num(r[c], base.rakebackRates[c]), 0, 1);
    }
  }

  base.rakebackPackBattleWeight = clamp(
    num(src.rakebackPackBattleWeight, 1),
    0,
    1,
  );
  base.rakebackUpgraderWeight = clamp(num(src.rakebackUpgraderWeight, 1), 0, 1);
  base.rakebackInstantPayoutPct = clamp(
    num(src.rakebackInstantPayoutPct, 1),
    0,
    1,
  );
  base.rakebackInstantAdoption = clamp(num(src.rakebackInstantAdoption, 0), 0, 1);

  // Affiliate per-tier rates (keyed by numeric level; 0..1).
  if (src.affiliateRates != null && typeof src.affiliateRates === "object") {
    const a = src.affiliateRates as Record<string, unknown>;
    for (const [k, v] of Object.entries(a)) {
      const lvl = Number(k);
      if (!Number.isFinite(lvl)) continue;
      base.affiliateRates[lvl] = clamp(num(v, 0), 0, 1);
    }
  }

  base.removeAffiliateWagerReq = src.removeAffiliateWagerReq === true;

  // Multiplier levers (0..5, matching the slider bounds the planner enforces).
  base.depositBonusMatchMult = clamp(num(src.depositBonusMatchMult, 1), 0, 5);
  base.depositBonusCapMult = clamp(num(src.depositBonusCapMult, 1), 0, 5);
  base.depositBonusMinDepositMult = clamp(
    num(src.depositBonusMinDepositMult, 1),
    0,
    5,
  );
  base.depositBonusWagerReqMult = clamp(
    num(src.depositBonusWagerReqMult, 1),
    0,
    5,
  );
  base.racePrizePoolMult = clamp(num(src.racePrizePoolMult, 1), 0, 5);
  base.raceFrequencyMult = clamp(num(src.raceFrequencyMult, 1), 0, 5);
  base.raceEntryCostMult = clamp(num(src.raceEntryCostMult, 1), 0, 5);
  base.rafflePrizePoolMult = clamp(num(src.rafflePrizePoolMult, 1), 0, 5);
  base.raffleFrequencyMult = clamp(num(src.raffleFrequencyMult, 1), 0, 5);
  base.raffleTicketCostMult = clamp(num(src.raffleTicketCostMult, 1), 0, 5);
  base.dailyPacksValueMult = clamp(num(src.dailyPacksValueMult, 1), 0, 5);
  base.dailyPacksFrequencyMult = clamp(num(src.dailyPacksFrequencyMult, 1), 0, 5);
  base.rainCostMult = clamp(num(src.rainCostMult, 1), 0, 5);

  base.signupGrantUsd = Math.max(0, num(src.signupGrantUsd, 0));

  return base;
}

/**
 * The house edge to seed a game-type lever with: the real empirical edge when
 * the sample is large enough, else derived from GGR / wager (the same quantity,
 * just below the sample-confidence gate). Clamped to a sane 0..1 band.
 */
export function effectiveTypeEdge(g: GameTypeBaseline): number {
  const raw =
    g.edge != null ? g.edge : g.wager > 0 ? g.ggr / g.wager : 0;
  return clamp(raw, 0, 1);
}

/**
 * The blended baseline edge across all types (real GGR / real wager). Used for
 * the headline "current edge" readout. Clamped 0..1.
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

/** A single game type's current-vs-planned GGR contribution. */
export type GameTypeProjection = {
  type: GameTypeId;
  label: string;
  wager: number;
  currentEdge: number;
  plannedEdge: number;
  currentGgr: number;
  plannedGgr: number;
  /** plannedGgr − currentGgr (positive = MORE house GGR = better). */
  ggrDelta: number;
  dataAvailable: boolean;
};

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
  /** When false, the lever is surfaced but has no real anchor (estimated). */
  dataAvailable: boolean;
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

  // ── Per-type GGR breakdown ──
  gameTypes: GameTypeProjection[];

  // ── Per-lever cost breakdown (for the comparison table / chart) ──
  levers: LeverProjection[];
};

/**
 * Run the full current-vs-planned projection. PURE — given the real baseline +
 * the planned levers, returns every figure the UI renders. No DB, no clock.
 *
 * Model:
 *   plannedGGR_type = plannedEdge_type × wager_type     (wager held at real volume)
 *   plannedGGR      = Σ plannedGGR_type
 *   leverCost_i     = realCost_i × f_i(planned)         (per-lever scaler)
 *   plannedNGR      = plannedGGR − Σ leverCost_i − otherRewardCost
 *   profitDelta     = plannedNGR − currentNGR
 *
 * Wager is held at the REAL observed volume (no elasticity guess) so the model
 * stays grounded and the deltas are pure config effects — the honest, defensible
 * planning number. (If a lever logically changes volume, that is a separate
 * behavioral assumption the per-reward forecast engines model; this unified
 * planner deliberately reports the direct config impact at constant volume.)
 */
export function projectEdgePlan(
  baseline: SystemEdgeBaseline,
  planned: PlannedLevers,
): EdgePlanProjection {
  // ── Per-type GGR ──
  const gameTypes: GameTypeProjection[] = baseline.gameTypes.map((g) => {
    const currentEdge = effectiveTypeEdge(g);
    const plannedEdge = clamp(planned.edges[g.type] ?? currentEdge, 0, 1);
    const currentGgr = currentEdge * g.wager;
    const plannedGgr = plannedEdge * g.wager;
    return {
      type: g.type,
      label: gameTypeLabel(g.type),
      wager: g.wager,
      currentEdge,
      plannedEdge,
      currentGgr,
      plannedGgr,
      ggrDelta: plannedGgr - currentGgr,
      dataAvailable: g.dataAvailable,
    };
  });

  const wager = baseline.wager;
  const currentGgr = gameTypes.reduce((s, g) => s + g.currentGgr, 0);
  const plannedGgr = gameTypes.reduce((s, g) => s + g.plannedGgr, 0);
  const currentEdge = wager > 0 ? currentGgr / wager : 0;
  const plannedEdge = wager > 0 ? plannedGgr / wager : 0;

  // ── Rakeback (per-cadence blend × per-type weighting × instant discount) ──
  const rakeback = projectRakeback(baseline, planned);

  // ── Affiliate (per-tier blend × 1× wager-req uplift) ──
  const affiliate = projectAffiliate(baseline, planned);

  // ── Deposit bonus (compose the four setting multipliers) ──
  const depositBonusFactor =
    Math.max(0, planned.depositBonusMatchMult) *
    Math.pow(Math.max(0, planned.depositBonusCapMult), DEPOSIT_BONUS_CAP_COST_EXPONENT) *
    eligibilityFactor(planned.depositBonusMinDepositMult) *
    breakageFactor(planned.depositBonusWagerReqMult);
  const depositBonusPlanned = baseline.depositBonusCost * depositBonusFactor;

  // ── Races (pool × frequency × entry-cost) — the real race_prize cost ──
  const raceFactor =
    Math.max(0, planned.racePrizePoolMult) *
    Math.max(0, planned.raceFrequencyMult) *
    ticketCostFactor(planned.raceEntryCostMult);
  const racePlanned = baseline.raceCost * raceFactor;

  // ── Raffles (pool × frequency × ticket-cost) — the real reconstructed
  //    raffle prize cost (a DISTINCT reward from races; see `raffleCost`). ──
  const raffleFactor =
    Math.max(0, planned.rafflePrizePoolMult) *
    Math.max(0, planned.raffleFrequencyMult) *
    ticketCostFactor(planned.raffleTicketCostMult);
  const rafflePlanned = baseline.raffleCost * raffleFactor;

  // ── Daily packs (value × frequency) ──
  const dailyPacksFactor =
    Math.max(0, planned.dailyPacksValueMult) *
    Math.max(0, planned.dailyPacksFrequencyMult);
  const dailyPacksPlanned = baseline.dailyPacksCost * dailyPacksFactor;

  // ── Signup packs (claimants × planned grant) ──
  const signupPlanned =
    baseline.signupClaimants * Math.max(0, planned.signupGrantUsd);

  // ── Rain (proportional multiplier on the real net rain cost) ──
  const rainPlanned = baseline.rainCost * Math.max(0, planned.rainCostMult);

  const hasUpgrader = baseline.gameTypes.some(
    (g) => g.type === "upgrader" && g.dataAvailable,
  );

  const levers: LeverProjection[] = [
    {
      key: "rakeback",
      label: "Rakeback",
      currentCost: rakeback.current,
      plannedCost: rakeback.planned,
      deltaCost: rakeback.planned - rakeback.current,
      dataAvailable: baseline.rakebackCost > 0,
    },
    {
      key: "affiliate",
      label: "Affiliate commission",
      currentCost: affiliate.current,
      plannedCost: affiliate.planned,
      deltaCost: affiliate.planned - affiliate.current,
      dataAvailable: baseline.affiliateCost > 0,
    },
    {
      key: "deposit-bonus",
      label: "Deposit bonus",
      currentCost: baseline.depositBonusCost,
      plannedCost: depositBonusPlanned,
      deltaCost: depositBonusPlanned - baseline.depositBonusCost,
      dataAvailable: baseline.depositBonusCost > 0,
    },
    {
      key: "races",
      label: "Races",
      currentCost: baseline.raceCost,
      plannedCost: racePlanned,
      deltaCost: racePlanned - baseline.raceCost,
      dataAvailable: baseline.raceCost > 0,
    },
    {
      key: "raffles",
      label: "Raffles",
      currentCost: baseline.raffleCost,
      plannedCost: rafflePlanned,
      deltaCost: rafflePlanned - baseline.raffleCost,
      dataAvailable: baseline.raffleCost > 0,
    },
    {
      key: "daily-packs",
      label: "Daily / free packs",
      currentCost: baseline.dailyPacksCost,
      plannedCost: dailyPacksPlanned,
      deltaCost: dailyPacksPlanned - baseline.dailyPacksCost,
      dataAvailable: baseline.dailyPacksCost > 0,
    },
    {
      key: "signup-packs",
      label: "Signup bonus",
      currentCost: baseline.signupPacksCost,
      plannedCost: signupPlanned,
      deltaCost: signupPlanned - baseline.signupPacksCost,
      dataAvailable: baseline.signupClaimants > 0,
    },
    {
      key: "rain",
      label: "Rain",
      currentCost: baseline.rainCost,
      plannedCost: rainPlanned,
      deltaCost: rainPlanned - baseline.rainCost,
      dataAvailable: baseline.rainCost > 0,
    },
    {
      // Motha (founder giveaway account) — informational line with no
      // lever (the founder's giveaway budget is a personal decision, not a
      // system-config knob this planner exposes). Same shape as the "other
      // reward cost" line: held fixed by the planner, surfaced so the
      // operator can see what the founder gave away over this window.
      key: "motha",
      label: "Motha giveaways",
      currentCost: baseline.mothaCost,
      plannedCost: baseline.mothaCost,
      deltaCost: 0,
      dataAvailable: baseline.mothaCost > 0,
    },
    {
      key: "other",
      label: "Other reward cost",
      currentCost: baseline.otherRewardCost,
      plannedCost: baseline.otherRewardCost,
      deltaCost: 0,
      dataAvailable: baseline.otherRewardCost > 0,
    },
  ];
  void hasUpgrader;

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

    gameTypes,
    levers,
  };
}

// ─── Per-lever projection helpers ────────────────────────────────────────────

/**
 * Rakeback projection. The realized rakeback cost scales with THREE planned
 * effects, multiplicatively:
 *
 *   1. Per-cadence rate blend: plannedBlend / currentBlend, where each blend is
 *      Σ(rate_c · w_c) and w_c is cadence c's share of the realized cost (an even
 *      split across enabled cadences — per-cadence realized cost is not
 *      separable from the rollup). At unchanged rates this is 1.0.
 *   2. Per-type wager weighting: the rakeback accrues on pack/battle wager and
 *      upgrader wager. Down-weighting either removes that slice's contribution:
 *        weightFactor = packBattleShare · pbWeight + upgraderShare · upgWeight
 *      (At both weights = 1.0 the shares sum to 1 → 1.0, neutral.)
 *   3. Instant-claim discount: a share `adoption` of claimants take an instant
 *      payout at `payoutPct` of their accrual; the rest accrue normally. So the
 *      realized cost across the adopting share is scaled by payoutPct:
 *        instantFactor = (1 − adoption) + adoption · payoutPct
 *      (At adoption = 0 OR payoutPct = 1 this is 1.0, neutral.)
 */
function projectRakeback(
  baseline: SystemEdgeBaseline,
  planned: PlannedLevers,
): { current: number; planned: number } {
  const current = baseline.rakebackCost;
  if (current <= 0) return { current: 0, planned: 0 };

  // (1) Per-cadence rate blend.
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

  // (2) Per-type wager weighting. Split the wager into pack/battle vs upgrader.
  const upgraderWager = baseline.gameTypes
    .filter((g) => g.type === "upgrader")
    .reduce((s, g) => s + g.wager, 0);
  const packBattleWager = Math.max(0, baseline.wager - upgraderWager);
  const totalWager = packBattleWager + upgraderWager;
  const pbShare = totalWager > 0 ? packBattleWager / totalWager : 1;
  const upgShare = totalWager > 0 ? upgraderWager / totalWager : 0;
  const pbWeight = clamp(planned.rakebackPackBattleWeight, 0, 1);
  const upgWeight = clamp(planned.rakebackUpgraderWeight, 0, 1);
  const weightFactor = pbShare * pbWeight + upgShare * upgWeight;

  // (3) Instant-claim discount.
  const adoption = clamp(planned.rakebackInstantAdoption, 0, 1);
  const payoutPct = clamp(planned.rakebackInstantPayoutPct, 0, 1);
  const instantFactor = (1 - adoption) + adoption * payoutPct;

  return {
    current,
    planned: Math.max(0, current * rateRatio * weightFactor * instantFactor),
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

/**
 * Deposit-bonus min-deposit eligibility scaler. RAISING the min deposit
 * (mult > 1) filters out small claimers → fewer claims → lower cost. Modeled as
 * an inverse scaler floored so it never goes negative: a 2× min-deposit gate ≈
 * 0.5× cost; a 0.5× gate (easier) ≈ ~2× cost (clamped). Conservative,
 * clearly-labeled planning assumption.
 */
function eligibilityFactor(minDepositMult: number): number {
  const m = Math.max(0.01, minDepositMult);
  return clamp(1 / m, 0, 4);
}

/**
 * Deposit-bonus wager-requirement breakage scaler. A HIGHER wager requirement
 * (mult > 1) raises breakage (more bonus expires unwagered) → lower realized
 * cost. Modeled as a mild inverse: each +1.0 of requirement trims ~25% off the
 * realized cost (floored at 0.25× so it never zeroes out).
 */
function breakageFactor(wagerReqMult: number): number {
  const m = Math.max(0, wagerReqMult);
  return clamp(1 - (m - 1) * 0.25, 0.25, 2);
}

/**
 * Entry-cost / ticket-cost scaler (shared by races + raffles). A HIGHER entry
 * cost (mult > 1) trims farming leakage → slightly lower prize cost; a lower
 * cost loosens entry → higher cost. Mild inverse, bounded.
 */
function ticketCostFactor(ticketCostMult: number): number {
  const m = Math.max(0.01, ticketCostMult);
  return clamp(1 - (m - 1) * 0.15, 0.5, 1.5);
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
