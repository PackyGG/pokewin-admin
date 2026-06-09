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
 *   GGR_type = edge_type × wager_type            (per game type; battles edge = 0)
 *   GGR      = Σ GGR_type                         (packs + upgrader; battles wager only)
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

/**
 * The OWNER-CHOSEN DEFAULT planning edges (NOT the measured edge).
 *
 * The planner seeds its edge sliders from these values — the edge the owner
 * wants to PLAN around — rather than from the live empirical edge. The real
 * measured edge is still surfaced as a small muted "measured: X%" reference next
 * to each control so the gap to reality stays visible, but the slider starts on
 * the planning default.
 *
 *   • Packs carry the house edge → 10.99% (includes pack opens inside battles).
 *   • Battles are a game mode — 0% incremental edge in planning (margin via packs).
 *   • Upgrader is its own separate edge → 10%.
 */
export const PLANNED_PACKS_BATTLES_EDGE_DEFAULT = 0.1099 as const;
export const PLANNED_BATTLES_EDGE_DEFAULT = 0 as const;
export const PLANNED_UPGRADER_EDGE_DEFAULT = 0.1 as const;

/** The owner-chosen default planned edge for a given game type. */
export function defaultPlannedEdge(type: GameTypeId): number {
  if (type === "upgrader") return PLANNED_UPGRADER_EDGE_DEFAULT;
  if (type === "battles") return PLANNED_BATTLES_EDGE_DEFAULT;
  return PLANNED_PACKS_BATTLES_EDGE_DEFAULT;
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

// ─── Daily / free packs (per-pack measured EV — the editable lever) ─────────

/** One card in a pack pool — for visual previews in the planner. */
export type PackCardPreview = {
  name: string;
  imageUrl: string | null;
  priceUsd: number;
};

/** Shared pack art + card strip used across daily, welcome, and catalog rows. */
export type PackVisualFields = {
  imageUrl: string | null;
  cardPreviews: PackCardPreview[];
};

/** Every reward pack in the catalog — gallery context for the packs tab. */
export type RewardPackCatalogItem = PackVisualFields & {
  packId: string;
  name: string;
  slug: string;
  active: boolean;
  cardsPerOpen: number;
  /** Theoretical EV per open from the live card pool (weight × price). */
  theoreticalEvUsd: number;
};

/**
 * One real reward pack (`packs.pack_type = 'reward'`) the owner tunes
 * individually. Each row carries the MEASURED average house cost per open
 * (`avgCostPerPack = giveawayPayout / opens` from `getDailyPacksGiveaway`),
 * which IS the empirically-observed EV per open. The owner scales THIS pack's
 * EV; the projection aggregates `Σ (plannedEv × opens) × frequency` back to a
 * cost delta. Cost basis stays GROSS `giveawayPayout` (the wager those opens
 * collect is ≈ $0 and already flows through `pack_opening` into GGR — netting
 * it would double-count; see `daily-packs.ts`).
 */
export type DailyPackLeverRow = PackVisualFields & {
  /** `packs.id`. */
  packId: string;
  /** `packs.name` (e.g. "Daily Tier 1"). */
  name: string;
  /** `packs.slug`. */
  slug: string;
  /** Distinct reward-pack opens in the window. */
  opens: number;
  /** Distinct users who opened this pack in the window. */
  claimers: number;
  /** Σ value_at_obtained of cards delivered (gross giveaway cost for this pack). */
  giveawayPayout: number;
  /**
   * Measured EV per open = giveawayPayout / opens (the house cost of one open).
   * The per-pack lever seeds from this. 0 when the pack had no opens.
   */
  measuredEvUsd: number;
};

// ─── Signup / welcome packs (read-only context) ─────────────────────────────

/**
 * One welcome / one-time reward `pack` reference the owner finally gets to see.
 *
 * Built from `rewards` rows of `type = 'one_time'` whose `pack_ids` point at a
 * `pack_type = 'reward'` pack, with the theoretical EV computed the SAME way as
 * `packs.ts getPackDetail`: `cards_per_open × Σ (weight / Σweight × cards.price)`.
 * DISPLAY-ONLY context (the signup COST itself is the cash `balance_reward_claim`
 * lever) — surfaced so the owner can see the tiny card-pack EVs that sit behind
 * the welcome grant. House-POV: a card giveaway is a house cost → rose.
 */
export type WelcomePackInfo = PackVisualFields & {
  /** The `rewards.slug` the pack is referenced from (e.g. "onboarding"). */
  rewardSlug: string;
  /** The `rewards.name` (e.g. "Welcome Reward"). */
  rewardName: string;
  /** `packs.id`. */
  packId: string;
  /** `packs.name`. */
  packName: string;
  /** `packs.slug`. */
  packSlug: string;
  /** Cards handed out per open (`packs.cards_per_open`). */
  cardsPerOpen: number;
  /**
   * Theoretical EV per open = cards_per_open × Σ(weight/Σweight × cards.price).
   * 0 when the referenced pack has no priced cards in its pool.
   */
  theoreticalEvUsd: number;
};

// ─── Affiliate tiers (the real ladder) ──────────────────────────────────────

/** One affiliate commission tier as the planner tunes it. */
export type AffiliateTierLever = {
  /** Ladder level (1 … N) from `affiliate_level_configs.level`. */
  level: number;
  /** Display label (e.g. "Level 5"). */
  label: string;
  /**
   * CURRENT commission share of referred house edge / GGR (decimal fraction,
   * e.g. 0.10 = 10% of edge → 1.05% of wager at a 10.5% house edge).
   */
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
   * Realized affiliate commission as a fraction of referred WAGER over the
   * window (= total commission ÷ downstream wager). This is the effective
   * wager drag; tier ladder rates are shares of edge — divide by house edge to
   * get the blended edge share. Null when wager is unknown.
   */
  affiliateBlendedRate: number | null;

  // ── Real daily / free-pack per-pack breakdown (the editable-EV lever) ──
  /**
   * One row per real reward pack (`pack_type = 'reward'`) with its MEASURED
   * EV per open, opens + giveaway cost. The daily-packs lever renders one
   * editable-EV row per pack and aggregates `Σ (plannedEv × opens) × frequency`.
   * Empty when no reward pack was opened in the window.
   */
  dailyPackRows: DailyPackLeverRow[];

  /** All reward packs (`pack_type = reward`) with art — gallery context. */
  rewardPackCatalog: RewardPackCatalogItem[];

  // ── Real signup-bonus anchors (for the signup lever readout + the bridge) ──
  /**
   * Real measured average signup balance-reward grant (USD per CLAIMANT) over
   * the window, or null when there were no claims. The signup lever's "grant"
   * control seeds from this — the TRUE per-claimant grant (`avgPerClaim`), NOT
   * the misleading amortized-per-signup figure. NOT the $5 nominal constant.
   */
  signupAvgGrant: number | null;
  /** Real signup claimants in the window (drives the grant-lever cost scaling). */
  signupClaimants: number;
  /** Real signups (the whole cohort) in the window — the bridge denominator. */
  signupSignups: number;
  /**
   * Real signup-bonus cost AMORTIZED across EVERY signup (= totalCost / signups,
   * incl. the majority who never claimed) — the misleading "$5.71". Surfaced as
   * a secondary efficiency metric ONLY, never as the welcome-pack value / grant.
   * `avgPerSignup = avgPerClaim × conversionPct` is the bridge the UI shows.
   */
  signupAvgPerSignup: number | null;
  /** Real claim-conversion fraction (0..1) = claimants / signups. The bridge factor. */
  signupConversionPct: number;
  /**
   * Real welcome / one-time reward PACK references + their theoretical EVs —
   * DISPLAY-ONLY context so the owner can see the tiny card-pack EVs behind the
   * welcome grant. Empty when no `one_time` reward points at a `pack_type =
   * 'reward'` pack. (The signup COST is the cash `balance_reward_claim` lever,
   * NOT these card EVs — surfaced separately, clearly labeled.)
   */
  welcomePacks: WelcomePackInfo[];

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

  // ── Real rain anchors (concrete net-slice breakdown) ──
  /**
   * Real Σ |rain_win| over the window — the GROSS rain winnings handed to users.
   * The net house slice is `max(0, rainWinTotal − rainTipTotal)` (= `rainCost`).
   * Surfaced so the rain lever can explain the net-slice math concretely.
   */
  rainWinTotal: number;
  /**
   * Real Σ |rain_tip| over the window — the user + founder contribution into
   * rain pools that the house did NOT fund. Netted off the gross win to get the
   * house slice. Surfaced for the rain lever's net-slice explanation.
   */
  rainTipTotal: number;
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
   * the requirement is IMPLICIT (screens ~35% of low-quality referred edge before
   * commission accrues); removing it widens the eligible referred-edge base.
   * Default false (keep the screen = current behavior). Clearly labeled what-if.
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

  // ── DAILY PACKS — per-pack editable EV + a shared frequency control ──
  /**
   * Planned EV per open (USD) keyed by `packs.id`, one entry per real reward
   * pack. Seeds from each pack's MEASURED `avgCostPerPack`. The owner scales a
   * single pack's EV directly (e.g. richer Daily Tier 10 cards). Projection:
   * `Σ (plannedEv[packId] × opens[packId]) × dailyPacksFrequencyMult`.
   */
  dailyPackEvUsd: Record<string, number>;
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

  // ── OTHER / FOUNDER (remainder + discretionary) ──
  /**
   * Scales the “other reward cost” bucket (gift cards, promo codes, waitlist,
   * manual vouchers + counted adjustments). 1.0 = current realized spend.
   */
  otherRewardCostMult: number;
  /**
   * Scales motha (founder giveaway account) outflow — creator tips, battle
   * sponsorship, rain tips funded by motha. 1.0 = current window.
   */
  mothaCostMult: number;
};

/**
 * Fraction of referred house-edge volume screened OUT by the implicit 1× wager
 * requirement before commission accrues — matches the affiliate-forecast
 * `qualityScreen: 0.35` what-if (churned / no-wager referrals).
 */
export const AFFILIATE_WAGER_REQ_QUALITY_SCREEN = 0.35 as const;

/**
 * Affiliate commission cost multiplier when the 1× wager screen is REMOVED.
 * Tier rates are unchanged; more referred GGR becomes commissionable:
 *   mult = 1 ÷ (1 − screen) ≈ 1.54 (+54% commission cost vs screened base).
 */
export const REMOVE_WAGER_REQ_COMMISSION_BASE_MULT =
  1 / (1 - AFFILIATE_WAGER_REQ_QUALITY_SCREEN);

/** Extra affiliate commission cost (fraction) when the screen is removed — for UI. */
export function removeWagerReqCommissionUplift(): number {
  return REMOVE_WAGER_REQ_COMMISSION_BASE_MULT - 1;
}

/** @deprecated Use `removeWagerReqCommissionUplift()` — kept for preset compat. */
export const REMOVE_WAGER_REQ_COST_UPLIFT = removeWagerReqCommissionUplift();

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

/**
 * Seed the planner's lever state from the baseline.
 *
 * EDGE seeds from the OWNER-CHOSEN PLANNING DEFAULTS (packs 10.99%, battles 0%,
 * upgrader 10%) — NOT the measured edge. The measured edge stays visible as a
 * muted reference on each control, but the slider opens on the planning target.
 * Upgrader keeps its planning default even when it has no data in the window
 * (the lever is surfaced + labeled "not yet wired", but still defaults to 10%).
 *
 * Every other lever still seeds from its REAL current value (rakeback /
 * affiliate rates, multipliers at 1.0, signup grant from the real average).
 */
export function defaultLevers(baseline: SystemEdgeBaseline): PlannedLevers {
  const edges: Record<GameTypeId, number> = {
    packs: PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
    battles: PLANNED_BATTLES_EDGE_DEFAULT,
    upgrader: PLANNED_UPGRADER_EDGE_DEFAULT,
  };
  // Honor every type present in the baseline with its planning default (keeps
  // the map complete even if the type list ever changes shape).
  for (const g of baseline.gameTypes) {
    edges[g.type] = defaultPlannedEdge(g.type);
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

  // Per-pack daily EV seeds from each pack's MEASURED avg cost per open.
  const dailyPackEvUsd: Record<string, number> = {};
  for (const p of baseline.dailyPackRows) {
    dailyPackEvUsd[p.packId] = Math.max(0, p.measuredEvUsd);
  }
  for (const p of baseline.rewardPackCatalog) {
    if (dailyPackEvUsd[p.packId] == null) {
      dailyPackEvUsd[p.packId] = Math.max(0, p.theoreticalEvUsd);
    }
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

    dailyPackEvUsd,
    dailyPacksFrequencyMult: 1,

    signupGrantUsd: baseline.signupAvgGrant ?? 0,

    rainCostMult: 1,
    otherRewardCostMult: 1,
    mothaCostMult: 1,
  };
}

/**
 * Neutral lever defaults (every multiplier 1.0, no rate, no toggles). EDGE falls
 * back to the owner-chosen planning defaults (packs 10.99%, battles 0%, upgrader
 * 10%) so a preset payload missing an edge key resolves to the planning target,
 * not 0.
 */
function neutralLevers(): PlannedLevers {
  return {
    edges: {
      packs: PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
      battles: PLANNED_BATTLES_EDGE_DEFAULT,
      upgrader: PLANNED_UPGRADER_EDGE_DEFAULT,
    },
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
    dailyPackEvUsd: {},
    dailyPacksFrequencyMult: 1,
    signupGrantUsd: 0,
    rainCostMult: 1,
    otherRewardCostMult: 1,
    mothaCostMult: 1,
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
    base.edges.battles = PLANNED_BATTLES_EDGE_DEFAULT;
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
  base.dailyPacksFrequencyMult = clamp(num(src.dailyPacksFrequencyMult, 1), 0, 5);
  base.rainCostMult = clamp(num(src.rainCostMult, 1), 0, 5);
  base.otherRewardCostMult = clamp(num(src.otherRewardCostMult, 1), 0, 5);
  base.mothaCostMult = clamp(num(src.mothaCostMult, 1), 0, 5);

  // Per-pack daily EV (keyed by pack id; non-negative USD). A stale preload
  // entry for a pack not in the current window simply never reaches the
  // projection (which iterates the live baseline rows), so an extra key here
  // is harmless — but we still drop non-finite values.
  if (src.dailyPackEvUsd != null && typeof src.dailyPackEvUsd === "object") {
    const d = src.dailyPackEvUsd as Record<string, unknown>;
    for (const [packId, v] of Object.entries(d)) {
      if (typeof packId !== "string" || packId.length === 0) continue;
      base.dailyPackEvUsd[packId] = Math.max(0, num(v, 0));
    }
  }

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
 * Measured packs-only house edge (Σ packs GGR ÷ Σ packs wager). Battles do not
 * carry a separate house edge in planning — pack opens in battles use packs edge.
 */
export function measuredPacksEdge(baseline: SystemEdgeBaseline): number {
  const packs = baseline.gameTypes.find((g) => g.type === "packs");
  if (!packs || packs.wager <= 0) return PLANNED_PACKS_BATTLES_EDGE_DEFAULT;
  const raw =
    packs.edge != null
      ? packs.edge
      : packs.ggr / packs.wager;
  return clamp(raw, 0, 1);
}

/** @deprecated Use measuredPacksEdge — battles have no separate house edge. */
export function blendedPackBattleEdge(baseline: SystemEdgeBaseline): number {
  return measuredPacksEdge(baseline);
}

/**
 * Wager-weighted blended edge for affiliate / headline math:
 * (packs_edge×packs_wager + upgrader_edge×upgrader_wager) ÷ total_wager,
 * with battles at 0% edge.
 */
export function blendedGamingEdge(
  baseline: SystemEdgeBaseline,
  edges: Record<GameTypeId, number>,
): number {
  const wager = baseline.wager;
  if (wager <= 0) return 0;
  let ggr = 0;
  for (const g of baseline.gameTypes) {
    const edge =
      g.type === "battles"
        ? PLANNED_BATTLES_EDGE_DEFAULT
        : clamp(edges[g.type] ?? defaultPlannedEdge(g.type), 0, 1);
    ggr += edge * g.wager;
  }
  return ggr / wager;
}

/**
 * Observed blended house edge for headline / "current config" reads:
 * (packs_measured×packs_wager + upgrader_measured×upgrader_wager) ÷ total_wager.
 * Battles wager is in the denominator only — never in the numerator.
 */
export function observedBlendedGamingEdge(
  baseline: SystemEdgeBaseline,
): number {
  const wager = baseline.wager;
  if (wager <= 0) return 0;
  let ggr = 0;
  for (const g of baseline.gameTypes) {
    ggr += effectiveProjectionTypeEdge(g, baseline) * g.wager;
  }
  return ggr / wager;
}

/**
 * Current edge for projection / overview display. Packs use measured packs edge;
 * battles are 0% (edge via packs); upgrader uses its measured edge when reliable.
 */
export function effectiveProjectionTypeEdge(
  g: GameTypeBaseline,
  baseline: SystemEdgeBaseline,
): number {
  if (g.type === "battles") {
    return PLANNED_BATTLES_EDGE_DEFAULT;
  }
  if (g.type === "packs") {
    return measuredPacksEdge(baseline);
  }
  const raw =
    g.edge != null ? g.edge : g.wager > 0 ? g.ggr / g.wager : null;
  if (raw != null && Number.isFinite(raw) && raw > 0) {
    return clamp(raw, 0, 1);
  }
  return PLANNED_UPGRADER_EDGE_DEFAULT;
}

/**
 * Raw empirical GGR ÷ wager across all types (includes battles settlement GGR).
 * Do NOT use for blended headline / affiliate edge — use `observedBlendedGamingEdge`.
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
    const isBattles = g.type === "battles";
    const currentEdge = isBattles
      ? PLANNED_BATTLES_EDGE_DEFAULT
      : effectiveProjectionTypeEdge(g, baseline);
    const plannedEdge = isBattles
      ? PLANNED_BATTLES_EDGE_DEFAULT
      : clamp(
          planned.edges[g.type] ?? defaultPlannedEdge(g.type),
          0,
          1,
        );
    const currentGgr = isBattles ? 0 : currentEdge * g.wager;
    const plannedGgr = isBattles ? 0 : plannedEdge * g.wager;
    return {
      type: g.type,
      label: gameTypeLabel(g.type),
      wager: g.wager,
      currentEdge,
      plannedEdge,
      currentGgr,
      plannedGgr,
      ggrDelta: isBattles ? 0 : plannedGgr - currentGgr,
      dataAvailable: g.dataAvailable,
    };
  });

  const wager = baseline.wager;
  const currentEdge = observedBlendedGamingEdge(baseline);
  const plannedEdge = plannedBlendedHouseEdge(baseline, planned);
  const currentGgr = currentEdge * wager;
  const plannedGgr = plannedEdge * wager;

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

  // ── Daily packs (per-pack EV × measured opens, then × frequency) ──
  // Cost basis = GROSS giveaway (cards out). Default planned EV per pack ==
  // its measured avg cost per open, so at defaults the aggregate reproduces
  // Σ giveawayPayout = baseline.dailyPacksCost exactly. Scaling one pack's EV
  // moves only that pack's slice; the frequency mult scales every pack.
  //
  // `dailyPacksCurrent` is the per-pack baseline sum (Σ measuredEv × opens),
  // which equals Σ giveawayPayout = baseline.dailyPacksCost when the per-pack
  // rows are present. When the per-pack rollup degraded to empty but the scalar
  // total survived, fall back to the scalar (so the lever still shows the real
  // cost and the frequency mult still works) — there are then just no editable
  // per-pack rows to render.
  const dailyFreq = Math.max(0, planned.dailyPacksFrequencyMult);
  const dailyPacksBaseFromRows = baseline.dailyPackRows.reduce(
    (s, p) => s + Math.max(0, p.measuredEvUsd) * p.opens,
    0,
  );
  const hasDailyRows = baseline.dailyPackRows.length > 0;
  const dailyPacksCurrent = hasDailyRows
    ? dailyPacksBaseFromRows
    : baseline.dailyPacksCost;
  const dailyPacksPlanned = hasDailyRows
    ? baseline.dailyPackRows.reduce((s, p) => {
        const ev = Math.max(
          0,
          planned.dailyPackEvUsd[p.packId] ?? p.measuredEvUsd,
        );
        return s + ev * p.opens;
      }, 0) * dailyFreq
    : baseline.dailyPacksCost * dailyFreq;

  // ── Signup packs (claimants × planned grant) ──
  const signupPlanned =
    baseline.signupClaimants * Math.max(0, planned.signupGrantUsd);

  // ── Rain (proportional multiplier on the real net rain cost) ──
  const rainPlanned = baseline.rainCost * Math.max(0, planned.rainCostMult);

  const mothaPlanned =
    baseline.mothaCost * Math.max(0, planned.mothaCostMult);
  const otherPlanned =
    baseline.otherRewardCost * Math.max(0, planned.otherRewardCostMult);

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
      currentCost: dailyPacksCurrent,
      plannedCost: dailyPacksPlanned,
      deltaCost: dailyPacksPlanned - dailyPacksCurrent,
      dataAvailable: dailyPacksCurrent > 0,
    },
    {
      // The signup cost is a CASH balance_reward_claim credit, NOT a card pack
      // (verified). Labeled accordingly so it never reads as a "welcome pack".
      key: "signup-packs",
      label: "Signup balance reward",
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
      plannedCost: mothaPlanned,
      deltaCost: mothaPlanned - baseline.mothaCost,
      dataAvailable: baseline.mothaCost > 0,
    },
    {
      key: "other",
      label: "Other reward cost",
      currentCost: baseline.otherRewardCost,
      plannedCost: otherPlanned,
      deltaCost: otherPlanned - baseline.otherRewardCost,
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

// ─── Net edge by scenario (reward erosion of the planned edge) ───────────────

/**
 * Affiliate ladder rates (`affiliate_level_configs.commission_rate`) are a **share
 * of referred house edge / GGR**, not a straight % of wager. Effective wager drag:
 *
 *     wager_drag = edge_share × house_edge
 *
 * e.g. tier 8 at 10% of edge with a 10.5% house edge → 1.05% of referred wager.
 *
 * Rakeback is different: `rakeback_config.percentage` is a per-$ rebate of wager,
 * so the planned blended rakeback rate erodes edge 1:1 on wager.
 *
 * Deposit bonus uses realized cost ÷ wager at the planned config.
 */

/** Planned blended house edge (Σ planned GGR ÷ Σ wager) for affiliate drag math. */
export function plannedBlendedHouseEdge(
  baseline: SystemEdgeBaseline,
  planned: PlannedLevers,
): number {
  return blendedGamingEdge(baseline, planned.edges);
}

/** Convert an affiliate tier rate (share of edge) to effective wager drag. */
export function affiliateEdgeShareToWagerDrag(
  edgeShare: number,
  houseEdge: number,
): number {
  return Math.max(0, edgeShare) * Math.max(0, houseEdge);
}

/** Realized wager drag → implied edge share at a given house edge. */
export function affiliateWagerDragToEdgeShare(
  wagerDrag: number,
  houseEdge: number,
): number {
  const edge = Math.max(0, houseEdge);
  return edge > 0 ? Math.max(0, wagerDrag) / edge : 0;
}

/** What basis a scenario's erosion is expressed on (labeled in the UI). */
export type EdgeErosionBasis = "affiliate" | "rakeback" | "deposit-bonus" | "none";

/** A single "net edge after this profile's reward erosion" row. */
export type NetEdgeScenario = {
  /** Stable key. */
  key: string;
  /** Display label (e.g. "Affiliate tier 8"). */
  label: string;
  /** Short note describing what the profile assumes. */
  note: string;
  /**
   * Total edge EROSION this scenario applies, as a 0..1 fraction of wager
   * (summed across its components). Subtracted from the gross planned edge.
   */
  erosion: number;
  /** The gross planned blended house edge before erosion (0..1). */
  grossEdge: number;
  /** netEdge = grossEdge − erosion (can be negative). */
  netEdge: number;
  /** Which basis(es) drive this row (drives the small basis label). */
  bases: EdgeErosionBasis[];
  /** True for the no-reward base row (rendered as the reference). */
  isBase: boolean;
};

/**
 * The blended rakeback rate the planner currently implies, as a 0..1 fraction of
 * wager — the cost-weighted average of the per-cadence planned rates across the
 * ENABLED cadences (the same even cost-weight `projectRakeback` uses). This is
 * the per-$ rakeback drag a fully-rakeback-eligible profile faces. Returns 0 when
 * no cadence is enabled / configured.
 */
export function plannedBlendedRakebackRate(
  baseline: SystemEdgeBaseline,
  planned: PlannedLevers,
): number {
  const cadences = baseline.rakebackCadences;
  if (cadences.length === 0) return 0;
  let sum = 0;
  let weight = 0;
  for (const c of cadences) {
    const w = cadenceWeight(c, cadences);
    const rate = Math.max(0, planned.rakebackRates[c.cadence] ?? c.currentRate);
    sum += rate * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}

/**
 * The realized deposit-bonus cost as a fraction of TOTAL wager at the planned
 * config — the wager-normalized drag the deposit bonus puts on the edge. Uses the
 * SAME planned deposit-bonus cost the main projection computes (so it reacts to
 * the deposit-bonus levers), divided by the observed wager. 0 when there is no
 * wager or no deposit-bonus spend. NOT a per-wager "rate" the backend enforces —
 * a realized-cost-over-wager basis, labeled as such in the UI.
 */
export function plannedDepositBonusEdgeDrag(
  baseline: SystemEdgeBaseline,
  planned: PlannedLevers,
): number {
  if (baseline.wager <= 0 || baseline.depositBonusCost <= 0) return 0;
  const factor =
    Math.max(0, planned.depositBonusMatchMult) *
    Math.pow(
      Math.max(0, planned.depositBonusCapMult),
      DEPOSIT_BONUS_CAP_COST_EXPONENT,
    ) *
    eligibilityFactor(planned.depositBonusMinDepositMult) *
    breakageFactor(planned.depositBonusWagerReqMult);
  const plannedCost = baseline.depositBonusCost * factor;
  return Math.max(0, plannedCost / baseline.wager);
}

/**
 * Build the "Net edge by scenario" rows — the EFFECTIVE net house edge after
 * reward erosion under scenarios derived from the REAL config. PURE: given the
 * baseline + the current planned levers, returns every row the UI renders, all
 * reacting live to the levers (planned edge, affiliate rates, rakeback rates,
 * deposit-bonus levers).
 *
 * Rows:
 *   (a) Base / no rewards   — planned blended house edge (gross).
 *   (b) one per affiliate tier — net = grossEdge − (tier edge share × grossEdge).
 *   (c) combined worst-cases — top tier + planned rakeback; + deposit bonus.
 *
 * `grossEdge` = planned blended house edge (Σ planned GGR ÷ Σ wager).
 */
export function computeNetEdgeScenarios(
  baseline: SystemEdgeBaseline,
  planned: PlannedLevers,
): NetEdgeScenario[] {
  const grossEdge = plannedBlendedHouseEdge(baseline, planned);

  const rows: NetEdgeScenario[] = [];

  // (a) Base — no reward erosion.
  rows.push({
    key: "base",
    label: "Base — no rewards",
    note: "Planned blended house edge before any reward erosion.",
    erosion: 0,
    grossEdge,
    netEdge: grossEdge,
    bases: ["none"],
    isBase: true,
  });

  // (b) One row per affiliate tier — ladder rate is a share of edge, not wager.
  const tiers = [...baseline.affiliateTiers].sort((a, b) => a.level - b.level);
  for (const t of tiers) {
    const edgeShare = Math.max(0, planned.affiliateRates[t.level] ?? t.currentRate);
    const wagerDrag = affiliateEdgeShareToWagerDrag(edgeShare, grossEdge);
    rows.push({
      key: `affiliate-${t.level}`,
      label: `Affiliate ${t.label.toLowerCase().startsWith("level") ? t.label : `tier ${t.level}`}`,
      note: `${formatRatePct(edgeShare)} of house edge → ${formatRatePct(wagerDrag)} of referred wager.`,
      erosion: wagerDrag,
      grossEdge,
      netEdge: grossEdge - wagerDrag,
      bases: ["affiliate"],
      isBase: false,
    });
  }

  // (c) Combined worst-cases.
  const topTier =
    tiers.length > 0 ? tiers[tiers.length - 1] : null;
  const topEdgeShare = topTier
    ? Math.max(0, planned.affiliateRates[topTier.level] ?? topTier.currentRate)
    : 0;
  const topWagerDrag = affiliateEdgeShareToWagerDrag(topEdgeShare, grossEdge);
  const rakebackRate = plannedBlendedRakebackRate(baseline, planned);
  const depDrag = plannedDepositBonusEdgeDrag(baseline, planned);

  if (topTier && (rakebackRate > 0 || topEdgeShare > 0)) {
    const erosion = topWagerDrag + rakebackRate;
    rows.push({
      key: "combo-top-rakeback",
      label: `Top tier + rakeback`,
      note: `Top affiliate tier (${formatRatePct(topEdgeShare)} of edge → ${formatRatePct(topWagerDrag)} of wager) + planned blended rakeback (${formatRatePct(rakebackRate)} of wager).`,
      erosion,
      grossEdge,
      netEdge: grossEdge - erosion,
      bases: ["affiliate", "rakeback"],
      isBase: false,
    });
  }

  if (topTier && (rakebackRate > 0 || depDrag > 0 || topEdgeShare > 0)) {
    const erosion = topWagerDrag + rakebackRate + depDrag;
    rows.push({
      key: "combo-top-rakeback-deposit",
      label: `Top tier + rakeback + deposit bonus`,
      note: `Adds the planned deposit-bonus drag (${formatRatePct(depDrag)} of wager — realized cost ÷ wager) on top of the top tier + rakeback.`,
      erosion,
      grossEdge,
      netEdge: grossEdge - erosion,
      bases: ["affiliate", "rakeback", "deposit-bonus"],
      isBase: false,
    });
  }

  return rows;
}

/** Format a 0..1 rate as a percent string for scenario notes (e.g. 0.1 → "10%"). */
function formatRatePct(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  const v = rate * 100;
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return `${s}%`;
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
 * Affiliate projection. Tier ladder rates are shares of referred edge; the
 * realized commission cost scales with the planned blended edge-share vs the
 * current blend (simple average of per-tier rates — the real per-affiliate tier
 * mix is not separable from the rollup). Removing the 1× wager requirement
 * widens the eligible referred-edge base (same 35% quality screen as the
 * affiliate forecast).
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

  const reqMult = planned.removeAffiliateWagerReq
    ? REMOVE_WAGER_REQ_COMMISSION_BASE_MULT
    : 1;

  return {
    current,
    planned: Math.max(0, current * rateRatio * reqMult),
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
