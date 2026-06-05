/**
 * types.ts — serializable models for the RAFFLE-PRIZES forecasting engine.
 *
 * Same idiom as the deposit-bonus reference: everything here is a PLAIN data
 * shape (no functions, no Decimal, no Date) so it round-trips through
 * `JSON.parse(JSON.stringify(x))` unchanged — a server component can pass it
 * across the Next 15 RSC boundary into the `"use client"` island, and a
 * scenario can be saved / shared / exported as plain JSON.
 *
 * ── Shared foundation ───────────────────────────────────────────────────────
 * The reward-agnostic result / baseline / recommendation shapes live in the
 * shared engine kit (`insights/_forecast-engine`) and are re-exported here so
 * the raffle UI wrapper + components import everything from one barrel. Only the
 * raffle-SPECIFIC shapes (segment ids, the raffle policy union, the policy-aware
 * Assumptions / ScenarioConfig) live in this file.
 *
 * ── Why raffles model differently from deposit-bonus ────────────────────────
 * A deposit bonus is a single per-claim DOLLAR cap. A raffle has no per-user
 * dollar cap — its cost is driven by THREE structural knobs:
 *   • the prize-pool SIZE per raffle,
 *   • how OFTEN raffles run (cadence / frequency),
 *   • the ticket RATE (how many tickets a user earns per $ wagered), which sets
 *     participation + how concentrated wins are among genuine vs farming
 *     entrants.
 * So the raffle "policy" is a {@link RafflePolicy} over those three axes, not a
 * cap rule. The shared `SimulationResult` shape is unchanged (cost / leakage /
 * retained / NGR / per-segment), so the generic UI + orchestration consume it
 * identically.
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
 * The four raffle ENTRY-VOLUME cohorts the forecast models. Raffles have no
 * fraud "abuse" cohorts the way deposit-bonus does; the genuinely-meaningful
 * segmentation is by how a user PARTICIPATES — which drives both how
 * concentrated prize value is and how much downstream play a win retains.
 * Stable string IDs so a saved scenario stays JSON-serializable.
 *
 *  • whale_entrant    — heavy ticket buyers (many points/entry). High retention,
 *                       low leakage (genuinely engaged).
 *  • regular_entrant  — steady mid-volume participants. The core cohort.
 *  • casual_entrant   — light, occasional entrants. Modest retention.
 *  • minimum_entrant  — single-/min-ticket entrants, incl. ticket-farmers who
 *                       enter purely for EV. Lowest retention, the cohort whose
 *                       captured prize value is "leakage" (a win here rarely
 *                       converts to genuine downstream play).
 */
export type SegmentId =
  | "whale_entrant"
  | "regular_entrant"
  | "casual_entrant"
  | "minimum_entrant";

// ─── Raffle policy (discriminated union) ────────────────────────────────────

/** Discriminant tag for {@link RafflePolicy}. */
export type PolicyKind =
  | "baseline"
  | "prize_pool"
  | "frequency"
  | "ticket_rate"
  | "combo";

/**
 * A raffle PROGRAM policy. Discriminated on `kind` so a scenario can be
 * persisted / shared as plain JSON and exhaustively matched in the engine.
 * Every multiplier is relative to the REAL measured baseline (1.0 = unchanged),
 * so the baseline scenario is literally `{ kind:"baseline" }` ≡ all-1.0.
 *
 *  • baseline     — the current program, every axis at 1.0 (the reference).
 *  • prize_pool   — scale the per-raffle prize POOL by `prizePoolMult`
 *                   (0.5 = halve prizes, 1.5 = +50%). Direct cost driver.
 *  • frequency    — scale how OFTEN raffles run by `frequencyMult`
 *                   (cadenceLabel is the human "weekly → 2×/week" hint). More
 *                   frequent ⇒ more total prize payout over the horizon.
 *  • ticket_rate  — scale tickets-earned-per-$ by `ticketRateMult`. Does NOT
 *                   change a raffle's prize cost directly; it changes
 *                   PARTICIPATION concentration → genuine-engagement share →
 *                   leakage + retention. A LOWER rate (harder to earn tickets)
 *                   tightens the field toward genuine entrants (less leakage,
 *                   some participation/retention given up).
 *  • combo        — all three axes at once (the balanced/tuned policy).
 */
export type RafflePolicy =
  | { kind: "baseline" }
  | { kind: "prize_pool"; prizePoolMult: number }
  | { kind: "frequency"; frequencyMult: number; cadenceLabel?: string }
  | { kind: "ticket_rate"; ticketRateMult: number }
  | {
      kind: "combo";
      prizePoolMult: number;
      frequencyMult: number;
      ticketRateMult: number;
      cadenceLabel?: string;
    };

// ─── Scenario config ────────────────────────────────────────────────────────

/**
 * A complete, shareable raffle scenario. Extends the generic
 * {@link BaseScenarioConfig} with the raffle-specific `policy`.
 */
export type ScenarioConfig = BaseScenarioConfig & {
  policy: RafflePolicy;
};

// ─── Assumptions (the tunable levers) ───────────────────────────────────────

/**
 * Every behavioural / volume assumption the raffle engine multiplies by.
 * Extends the generic {@link BaseAssumptions} (the reward-agnostic volume +
 * claim levers the shared orchestration reads) with the raffle-SPECIFIC levers.
 * In the UI each is a slider seeded from a `DEFAULT_*` constant (or the real
 * baseline for the data anchors).
 *
 * Rates / fractions / multipliers only — never raw money except `avgBonusUsd`
 * (here: the average prize value PER WINNER). The engine clamps everything
 * defensively; callers should keep fractions in [0,1] and multipliers ≥ 0.
 *
 * VOLUME is anchored to the REAL measured WINNER count (no synthetic
 * population): `baselineClaimants` (= winners) over `baselinePeriodDays` is
 * scaled to the forecast horizon, then modulated by the frequency multiplier
 * (more raffles ⇒ more winners) and the claim-probability lever relative to its
 * REAL default. See {@link ForecastBaseline}.
 */
export type Assumptions = BaseAssumptions & {
  /** Fractional split of winners across entry-volume segments — engine normalizes to sum 1. */
  segmentMix: Record<SegmentId, number>;
  /**
   * Share of prize value captured by min-ticket / EV-farming entrants at the
   * BASELINE ticket rate, 0-1. The raffle analog of deposit-bonus "abuse share"
   * — value paid out that generates little genuine downstream play. DEMO
   * assumption (a what-if input, NOT a fraud signal).
   */
  farmingShare: number;
  /**
   * How strongly a TIGHTER ticket rate (harder to earn tickets) suppresses
   * farming-captured value, 0-1 (1 = fully elastic). Higher ⇒ tightening the
   * rate squeezes more leakage.
   */
  farmingCaptureElasticity: number;
  /** Incremental retained downstream revenue per $1 of prize paid to genuine entrants. */
  retentionUplift: number;
  /**
   * Share of prize value that is "expired"/unclaimed-equivalent — a won item
   * the user never engages with (sits in inventory, never re-wagered). Shrinks
   * the retention base; the prize is still a cost. 0-1.
   */
  breakageRate: number;
  /**
   * Share of prize value paid to users who'd have wagered anyway (the raffle
   * didn't drive incremental play). Rises as the prize pool grows past the
   * over-generous threshold. 0-1.
   */
  cannibalizationRate: number;
  /**
   * Genuine participation/conversion lost per unit of ticket-rate tightening,
   * 0-1. Higher ⇒ a harder ticket rate sacrifices more genuine entrants → net
   * savings < gross.
   */
  participationSensitivity: number;
};
