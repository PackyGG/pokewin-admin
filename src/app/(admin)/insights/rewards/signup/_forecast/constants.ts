/**
 * Named assumptions for the SIGNUP-BONUS forecast engine.
 *
 * RULE (mirrors `insights/edge-calc/math.ts` + the deposit-bonus reference):
 * there are NO magic numbers downstream. Every coefficient the engine
 * multiplies by lives here as a `SCREAMING_SNAKE_CASE` export with a one-line
 * rationale, so an admin can read off exactly what the model assumes and tune
 * one knob in one place.
 *
 * Many of these are DEMO seeds (clearly tagged). They are starting values for
 * the UI sliders — illustrative, not measured. The DEMO-vs-real split is:
 *
 *   REAL (fetched server-side, see `types.ForecastBaseline`, mapped from
 *   `getSignupOverview` + the largest measured grant from
 *   `getSignupTopRecipients`):
 *     • baseline total grant cost, claimants, avg grant       → getSignupOverview
 *     • claim rate (claimants ÷ signups)                      → getSignupOverview
 *     • empirical cap (largest single grant)                  → getSignupTopRecipients
 *
 *   DEMO / assumption (sliders seeded from the DEFAULT_* below):
 *     • FTD conversion rate, breakage, abuse share, deposit-gate elasticity,
 *       retention uplift, legit-conversion sensitivity, segment mix.
 *
 * Changing a value here only affects NEW simulations — nothing is persisted.
 */

import type { SegmentId } from "./types";

// ─── Accent colors (house UI palette, House-POV) ────────────────────────────

/** Tile accent keys understood by `modern-panels.tsx` (`TILE_COLORS`). */
export type AccentColor =
  | "blue"
  | "emerald"
  | "rose"
  | "cyan"
  | "amber"
  | "purple"
  | "orange"
  | "pink";

/**
 * The five modeled segments, their display labels and a stable accent color.
 * Order is the canonical display order (high-value FTD first, abuse last).
 */
export const SEGMENTS: { id: SegmentId; label: string; accent: AccentColor }[] = [
  { id: "ftd_high_value", label: "FTD · high value", accent: "emerald" },
  { id: "ftd_low_value", label: "FTD · low value", accent: "cyan" },
  { id: "engaged_no_deposit", label: "Engaged · no deposit", accent: "purple" },
  { id: "dormant_no_deposit", label: "Dormant · no deposit", accent: "amber" },
  { id: "multi_account_abuse", label: "Multi-account abuse", accent: "rose" },
];

/** Stable id list (handy for iteration / normalization). */
export const SEGMENT_IDS: SegmentId[] = SEGMENTS.map((s) => s.id);

// ─── Baseline reference (Scenario A) ────────────────────────────────────────

/**
 * Current production welcome-grant value ($) — the reference figure the
 * baseline scenario advertises. The forecast ANCHORS the baseline scenario's
 * total cost on the REAL measured total (via `simulateSet`'s anchor), so this
 * constant only seeds the baseline scenario's nominal grant; the displayed
 * baseline cost is always the real production number.
 */
export const BASELINE_GRANT_USD = 5;

/**
 * Default lifetime cap ($) on total grants per user (welcome + level-ups). The
 * baseline is effectively "the welcome grant only" — this is the headroom a
 * tiered/level-up policy can grow into. Set comfortably above the welcome grant
 * so the baseline scenario does not clamp.
 */
export const BASELINE_PER_USER_CAP_USD = 25;

// ─── Default assumptions (UI slider seeds — DEMO) ───────────────────────────

/**
 * Fallback claim rate seed (claimants ÷ signups). The live page DEFAULTS the
 * slider to the REAL measured ratio (`ForecastBaseline.claimProbability`); this
 * constant is only the last-resort fallback when no real ratio is available
 * (e.g. the engine self-check harness, or a malformed shared link).
 */
export const DEFAULT_CLAIM_PROBABILITY = 0.7;

/**
 * DEMO seed — baseline FTD (first-time-deposit) conversion rate of the signup
 * cohort. Repurposes the generic `depositsPerUserPerWindow` lever: the share of
 * signups that go on to make a qualifying first deposit. The live page seeds
 * this from the real first-deposit conversion when available. The single most
 * important downstream-value driver and the thing a deposit gate prices against.
 */
export const DEFAULT_FTD_CONVERSION_RATE = 0.18;

/** DEMO seed — awarded-but-never-wagered share of the grant. */
export const DEFAULT_BREAKAGE_RATE = 0.34;

/** DEMO seed — baseline abusive-claimant share at the ungated baseline grant. */
export const DEFAULT_ABUSE_SHARE = 0.12;

/**
 * Coefficient — how strongly a deposit gate suppresses abuse (0-1). A signup
 * deposit gate is highly effective: bonus-only farmers never deposit, so a full
 * gate captures most baseline abuse. Higher than the deposit-bonus cap
 * elasticity because the gate is a hard eligibility wall, not a soft ceiling.
 */
export const DEFAULT_DEPOSIT_GATE_CAPTURE_ELASTICITY = 0.8;

/** Coefficient — retained downstream revenue per $1 of grant paid to a legit FTD. */
export const DEFAULT_RETENTION_UPLIFT = 0.22;

/**
 * Coefficient — legit (genuine FTD) conversion lost per unit of deposit-gate
 * friction (0-1). Gating deters some users who'd have converted after trying
 * the product free; this prices that.
 */
export const DEFAULT_LEGIT_CONVERSION_SENSITIVITY = 0.25;

/** Fallback avg grant ($) — live page defaults to the real `avgBonusUsd`. */
export const DEFAULT_AVG_BONUS_USD = 5;

/** Default forecast horizon (days). */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Signup grants are credited once at signup (plus any earned level-ups) — they
 * are NOT a per-window deposit-matched bonus. The generic
 * `depositsPerUserPerWindow` lever is repurposed as the FTD conversion rate, so
 * this constant exists only to satisfy the generic `BaseAssumptions` shape and
 * mirror the reference; the signup engine does not multiply cost by a per-window
 * deposit frequency.
 */
export const DEFAULT_DEPOSITS_PER_USER_PER_WINDOW = DEFAULT_FTD_CONVERSION_RATE;

/**
 * DEMO segment mix — fractions that sum to 1. These are the fixed shares the
 * demo dataset uses; the engine re-normalizes whatever the sliders produce.
 * Shape: most signups never deposit (engaged or dormant), a slice convert to
 * FTD, a small tail is multi-account abuse — the realistic shape of a free
 * welcome grant on a deposit-driven platform.
 */
export const DEFAULT_SEGMENT_MIX: Record<SegmentId, number> = {
  ftd_high_value: 0.06,
  ftd_low_value: 0.14,
  engaged_no_deposit: 0.3,
  dormant_no_deposit: 0.38,
  multi_account_abuse: 0.12,
};

// ─── Grant-mechanics coefficients ───────────────────────────────────────────

/**
 * EFFECTIVE-GRANT COST MODEL — the directional truth the cost channel encodes.
 *
 * Total claims/payout over the horizon is anchored to the REAL measured
 * claimant count scaled to the horizon (see `Assumptions` / `ForecastBaseline`),
 * NOT to any synthetic population. Cost differences between policies come from
 * the EFFECTIVE per-claimant grant a policy pays:
 *
 *   • a smaller flat grant pays less per claimant → lower cost,
 *   • a DEPOSIT GATE multiplies the claiming population by the share that
 *     actually deposits-to-unlock (bonus-only farmers drop out) → fewer paid
 *     grants, the strongest cost lever for a signup reward,
 *   • a TIERED/LEVEL-UP policy pays a small instant grant to everyone plus
 *     tranches only to the engaged share → cost shifts onto users who play,
 *   • a PER-USER CAP clamps the lifetime total a heavy level-upper accrues.
 *
 * The displayed baseline cost is anchored to the REAL total; other scenarios
 * read as coherent fractions/multiples via their effective-grant ratio.
 */
export const EFFECTIVE_GRANT_MODEL = "effective-grant × gated-claimants" as const;

/**
 * The share of the claiming population a deposit gate RETAINS as paid grants,
 * at full gate strength, expressed relative to the FTD conversion rate. A
 * deposit-gated grant is only paid to users who make a qualifying deposit, so
 * the paid population collapses toward the FTD rate. This floor stops the gate
 * from zeroing the program entirely (some non-FTD users deposit just to unlock,
 * then never again) — the gate retains at least this fraction beyond the raw
 * FTD rate.
 */
export const DEPOSIT_GATE_RETENTION_FLOOR = 0.05;

/**
 * Above this per-user lifetime grant cap ($), extra headroom mostly accrues to
 * users who'd have engaged anyway → diminishing retention. Set above the
 * baseline cap so the baseline itself sits below the knee.
 */
export const OVERGENEROUS_CAP_THRESHOLD_USD = 50;

/**
 * Extra breakage fraction added per $1 of per-user cap above
 * `OVERGENEROUS_CAP_THRESHOLD_USD`. A roomier lifetime cap lets more grant pile
 * up unused on dormant accounts → marginally higher breakage. 0.003 ⇒ a $100
 * cap (i.e. $50 over) adds +0.15 to the breakage fraction (clamped by the
 * engine).
 */
export const OVERGENEROUS_BREAKAGE_SLOPE = 0.003;

/** ±band on projected cost: ±15% (confidence interval, not a guarantee). */
export const CONFIDENCE_BAND_SPREAD = 0.15;

// ─── Friction weights (0-100 composite) ─────────────────────────────────────

/**
 * Weight: a DEPOSIT GATE is the dominant friction for a signup reward — it
 * stands between the new user and the grant. A full gate adds this much.
 */
export const FRICTION_W_DEPOSIT_GATE = 60;

/**
 * Weight: a higher minimum-deposit threshold ($) adds friction proportional to
 * how steep the threshold is (vs the reference threshold). Scales the gate
 * penalty up for steeper gates.
 */
export const FRICTION_W_GATE_STEEPNESS = 25;

/** Weight: a multi-tier level-up structure adds mild friction (effort to earn). */
export const FRICTION_W_TIERING = 15;

/**
 * Reference minimum-deposit ($) at which gate-steepness friction saturates to
 * its full weight. A $25 unlock is treated as a "steep" gate; anything at or
 * above this is maximally steep on that axis.
 */
export const GATE_STEEPNESS_REFERENCE_USD = 25;

// ─── Pacing curves (deterministic daily spread) ─────────────────────────────

/**
 * Front-load factor for INSTANT grants (flat / deposit-gated): a welcome grant
 * is credited at signup, so the cost clusters with the daily signup inflow —
 * effectively flat across the horizon (signups arrive roughly uniformly). 1.0 =
 * flat.
 */
export const INSTANT_GRANT_FRONTLOAD = 1.0;

/**
 * Front-load factor for TIERED/LEVEL-UP grants: the instant grant lands at
 * signup but the level-up tranches accrue as users play, so the cost ramps —
 * the series is BACK-loaded (front-load < 1 means later days carry more). 0.7
 * shifts weight toward the back of the horizon.
 */
export const TIERED_GRANT_FRONTLOAD = 0.7;

// ─── Numerical guards ───────────────────────────────────────────────────────

/** Smallest denominator we treat as non-zero before short-circuiting to 0. */
export const EPSILON = 1e-9;
