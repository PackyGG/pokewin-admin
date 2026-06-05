/**
 * scenarios.ts — the shippable RAFFLE scenario library.
 *
 * Plain serializable `ScenarioConfig` objects (no functions / Decimal / Date),
 * so the UI can hand any of these straight into `simulate()` and round-trip them
 * as JSON. Every policy multiplier is relative to the REAL measured baseline
 * (1.0 = unchanged), so Scenario A is the literal current program.
 *
 * Families:
 *   A — Current baseline           (all axes 1.0, the reference)
 *   B — Prize-pool size            (0.5× … 1.75× the per-raffle pool)
 *   C — Frequency / cadence        (0.5× … 3× how often raffles run)
 *   D — Ticket rate                (0.5× harder … 1.5× easier to earn tickets)
 *   E — Combo / tuned policies     (lean / balanced / aggressive growth)
 *
 * `RAFFLE_WHATIF_SET` is the focused comparison row set: baseline plus a clean
 * prize-pool gradient and the headline frequency/ticket-rate anchors, so the
 * table shows how cost / leakage move along each single axis.
 */

import type { ScenarioConfig } from "./types";

// ─── A — Current baseline ───────────────────────────────────────────────────

export const SCENARIO_A_BASELINE: ScenarioConfig = {
  id: "A-baseline",
  label: "A · Current program",
  description:
    "The current raffle program exactly as it runs today — prize pool, cadence and ticket rate all unchanged. The reference every other scenario is measured against (savings vs baseline = 0).",
  policy: { kind: "baseline" },
  schemaVersion: 1,
};

// ─── B — Prize-pool size ──────────────────────────────────────────────────────

export const SCENARIO_B_POOL_050: ScenarioConfig = {
  id: "B-pool-050",
  label: "B · Half prize pool",
  description:
    "Halve the per-raffle prize pool (0.5×). The cheapest prize policy in the library — directly cuts prize cost, but also halves the retention base genuine winners generate.",
  policy: { kind: "prize_pool", prizePoolMult: 0.5 },
  schemaVersion: 1,
};

export const SCENARIO_B_POOL_075: ScenarioConfig = {
  id: "B-pool-075",
  label: "B · −25% prize pool",
  description:
    "Trim the per-raffle prize pool to 0.75×. A modest cost reduction that keeps prizes attractive while lowering payout.",
  policy: { kind: "prize_pool", prizePoolMult: 0.75 },
  schemaVersion: 1,
};

export const SCENARIO_B_POOL_125: ScenarioConfig = {
  id: "B-pool-125",
  label: "B · +25% prize pool",
  description:
    "Grow the per-raffle prize pool to 1.25×. Bigger prizes lift participation pull and retention headroom at a proportionally higher cost.",
  policy: { kind: "prize_pool", prizePoolMult: 1.25 },
  schemaVersion: 1,
};

export const SCENARIO_B_POOL_150: ScenarioConfig = {
  id: "B-pool-150",
  label: "B · +50% prize pool",
  description:
    "Grow the per-raffle prize pool to 1.5× — past the over-generous knee (1.4×), where cannibalization begins to climb (more prize value reaches users who'd have wagered anyway).",
  policy: { kind: "prize_pool", prizePoolMult: 1.5 },
  schemaVersion: 1,
};

export const SCENARIO_B_POOL_175: ScenarioConfig = {
  id: "B-pool-175",
  label: "B · +75% prize pool",
  description:
    "Aggressively grow the per-raffle prize pool to 1.75×. The richest single-axis prize policy — strong pull, but cannibalization and cost both climb hard.",
  policy: { kind: "prize_pool", prizePoolMult: 1.75 },
  schemaVersion: 1,
};

// ─── C — Frequency / cadence ──────────────────────────────────────────────────

export const SCENARIO_C_FREQ_050: ScenarioConfig = {
  id: "C-freq-050",
  label: "C · Half as often",
  description:
    "Run raffles half as often (0.5× cadence). Fewer draws over the horizon ⇒ lower total prize cost AND fewer winners, but the program loses some of its pull.",
  policy: { kind: "frequency", frequencyMult: 0.5, cadenceLabel: "≈ every 2 weeks" },
  schemaVersion: 1,
};

export const SCENARIO_C_FREQ_150: ScenarioConfig = {
  id: "C-freq-150",
  label: "C · 1.5× as often",
  description:
    "Run raffles 1.5× as often. More draws ⇒ more total prize payout and more winners over the horizon, with mild cadence churn.",
  policy: { kind: "frequency", frequencyMult: 1.5, cadenceLabel: "≈ 3 / 2 weeks" },
  schemaVersion: 1,
};

export const SCENARIO_C_FREQ_200: ScenarioConfig = {
  id: "C-freq-200",
  label: "C · Twice as often",
  description:
    "Double the raffle cadence (2×). Total prize cost and winner volume scale up proportionally; cadence churn adds noticeable participation fatigue.",
  policy: { kind: "frequency", frequencyMult: 2, cadenceLabel: "≈ 2× / week" },
  schemaVersion: 1,
};

export const SCENARIO_C_FREQ_300: ScenarioConfig = {
  id: "C-freq-300",
  label: "C · 3× as often",
  description:
    "Triple the raffle cadence (3×). Maximum volume in the library — the highest total prize cost and the most cadence churn.",
  policy: { kind: "frequency", frequencyMult: 3, cadenceLabel: "≈ 3× / week" },
  schemaVersion: 1,
};

// ─── D — Ticket rate ────────────────────────────────────────────────────────

export const SCENARIO_D_RATE_050: ScenarioConfig = {
  id: "D-rate-050",
  label: "D · Half ticket rate",
  description:
    "Halve tickets earned per $ wagered (0.5×) — much harder to earn entries. Squeezes farming-captured prize value hardest (genuine field concentrates), at the cost of genuine participation and retention.",
  policy: { kind: "ticket_rate", ticketRateMult: 0.5 },
  schemaVersion: 1,
};

export const SCENARIO_D_RATE_075: ScenarioConfig = {
  id: "D-rate-075",
  label: "D · −25% ticket rate",
  description:
    "Tighten tickets earned per $ to 0.75×. A moderate anti-farming throttle — captures some leakage while giving up less participation than the half-rate variant.",
  policy: { kind: "ticket_rate", ticketRateMult: 0.75 },
  schemaVersion: 1,
};

export const SCENARIO_D_RATE_125: ScenarioConfig = {
  id: "D-rate-125",
  label: "D · +25% ticket rate",
  description:
    "Loosen tickets earned per $ to 1.25× — easier to enter. Boosts participation but widens the field to more EV-farming entrants (leakage rises). Prize cost itself is unchanged.",
  policy: { kind: "ticket_rate", ticketRateMult: 1.25 },
  schemaVersion: 1,
};

export const SCENARIO_D_RATE_150: ScenarioConfig = {
  id: "D-rate-150",
  label: "D · +50% ticket rate",
  description:
    "Loosen tickets earned per $ to 1.5× — maximum entry generosity. Highest participation in the library, but also the most farming leakage; prize cost unchanged.",
  policy: { kind: "ticket_rate", ticketRateMult: 1.5 },
  schemaVersion: 1,
};

// ─── E — Combo / tuned policies ──────────────────────────────────────────────

export const SCENARIO_E_LEAN: ScenarioConfig = {
  id: "E-lean",
  label: "E · Lean program",
  description:
    "Cost-cutting combo: smaller pool (0.75×), slightly less frequent (0.85×) and a tighter ticket rate (0.75×). Squeezes both prize cost and farming leakage — the leanest balanced policy.",
  policy: {
    kind: "combo",
    prizePoolMult: 0.75,
    frequencyMult: 0.85,
    ticketRateMult: 0.75,
    cadenceLabel: "slightly rarer",
  },
  schemaVersion: 1,
};

export const SCENARIO_E_BALANCED: ScenarioConfig = {
  id: "E-balanced",
  label: "E · Balanced anti-farming",
  description:
    "Hold the prize pool and cadence at baseline but tighten the ticket rate to 0.8× — captures farming leakage with minimal cost change. The targeted anti-farming policy.",
  policy: {
    kind: "combo",
    prizePoolMult: 1,
    frequencyMult: 1,
    ticketRateMult: 0.8,
    cadenceLabel: "unchanged",
  },
  schemaVersion: 1,
};

export const SCENARIO_E_GROWTH: ScenarioConfig = {
  id: "E-growth",
  label: "E · Growth push",
  description:
    "Engagement-growth combo: bigger pool (1.3×), more frequent (1.5×) and an easier ticket rate (1.25×). Maximizes participation and retention pull — and cost. The expansion policy.",
  policy: {
    kind: "combo",
    prizePoolMult: 1.3,
    frequencyMult: 1.5,
    ticketRateMult: 1.25,
    cadenceLabel: "more frequent",
  },
  schemaVersion: 1,
};

export const SCENARIO_E_TUNED: ScenarioConfig = {
  id: "E-tuned",
  label: "E · Tuned retention",
  description:
    "Retention-tuned combo: a slightly bigger pool (1.15×) at baseline cadence with a mildly tighter ticket rate (0.9×) — richer prizes for a more genuine field, trading a little cost for cleaner retention.",
  policy: {
    kind: "combo",
    prizePoolMult: 1.15,
    frequencyMult: 1,
    ticketRateMult: 0.9,
    cadenceLabel: "unchanged",
  },
  schemaVersion: 1,
};

// ─── Library aggregate ────────────────────────────────────────────────────────

/** The full shippable raffle scenario library (A–E), baseline first. */
export const SCENARIO_LIBRARY: ScenarioConfig[] = [
  // A — baseline (always row 0)
  SCENARIO_A_BASELINE,
  // B — prize-pool gradient (0.5 → 1.75)
  SCENARIO_B_POOL_050,
  SCENARIO_B_POOL_075,
  SCENARIO_B_POOL_125,
  SCENARIO_B_POOL_150,
  SCENARIO_B_POOL_175,
  // C — frequency gradient (0.5 → 3)
  SCENARIO_C_FREQ_050,
  SCENARIO_C_FREQ_150,
  SCENARIO_C_FREQ_200,
  SCENARIO_C_FREQ_300,
  // D — ticket-rate gradient (0.5 → 1.5)
  SCENARIO_D_RATE_050,
  SCENARIO_D_RATE_075,
  SCENARIO_D_RATE_125,
  SCENARIO_D_RATE_150,
  // E — combo / tuned policies
  SCENARIO_E_LEAN,
  SCENARIO_E_BALANCED,
  SCENARIO_E_TUNED,
  SCENARIO_E_GROWTH,
];

// ─── Raffle what-if set (the comparison-table rows) ───────────────────────────

/**
 * Focused comparison set. Row 0 is the baseline so the table's savings columns
 * populate relative to the current program. The prize-pool rows form a clean
 * gradient (0.5 → 1.5) so the table shows how cost / cannibalization move as the
 * pool scales; the frequency + ticket-rate anchors round out the single-axis
 * comparison.
 */
export const RAFFLE_WHATIF_SET: ScenarioConfig[] = [
  SCENARIO_A_BASELINE,
  // Prize-pool gradient
  SCENARIO_B_POOL_050,
  SCENARIO_B_POOL_075,
  SCENARIO_B_POOL_125,
  SCENARIO_B_POOL_150,
  // Frequency anchors
  SCENARIO_C_FREQ_050,
  SCENARIO_C_FREQ_200,
  // Ticket-rate anchors
  SCENARIO_D_RATE_050,
  SCENARIO_D_RATE_150,
  // The targeted anti-farming combo
  SCENARIO_E_BALANCED,
];

/** The id of the reference (baseline) scenario shared by both sets. */
export const BASELINE_SCENARIO_ID = SCENARIO_A_BASELINE.id;
