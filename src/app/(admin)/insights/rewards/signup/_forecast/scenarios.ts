/**
 * scenarios.ts — the shippable signup-bonus scenario library.
 *
 * Plain serializable `ScenarioConfig` objects (no functions / Decimal / Date),
 * so the UI can hand any of these straight into `simulate()` and round-trip
 * them as JSON. The baseline references the named constants
 * (`BASELINE_GRANT_USD` / `BASELINE_PER_USER_CAP_USD`) so Scenario A stays the
 * literal current policy (an ungated flat welcome grant).
 *
 * Families:
 *   A — Current baseline           (ungated flat welcome grant)
 *   B — Flat-grant value gradient  ($2 / $3 / $7 / $10 / $15 ungated)
 *   C — Deposit-gated              (unlock the grant after a $1 / $5 / $10 / $20
 *                                   first deposit — the anti-abuse lever)
 *   D — Tiered / level-up          (a small instant grant + level-up tranches
 *                                   that accrue with play)
 *   E — Dynamic per-segment        (smart targeting: generous to FTD-likely
 *                                   cohorts, tiny to abuse cohorts; gated + not)
 *
 * `GATED_WHATIF_SET` is the focused comparison row set: baseline plus the
 * deposit-gate gradient and the leanest tiered + dynamic variants — the
 * "how do we cut signup-bonus leakage without killing genuine FTDs" question.
 */

import { BASELINE_GRANT_USD, BASELINE_PER_USER_CAP_USD } from "./constants";
import type { ScenarioConfig } from "./types";

// ─── A — Current baseline ───────────────────────────────────────────────────

export const SCENARIO_A_BASELINE: ScenarioConfig = {
  id: "A-baseline",
  label: "A · Current baseline",
  description: `Current policy: a flat $${BASELINE_GRANT_USD} welcome grant credited to every signup, no deposit gate. The reference every other scenario is measured against (savings vs baseline = 0).`,
  grant: { kind: "flat_grant", grantUsd: BASELINE_GRANT_USD, perUserCapUsd: BASELINE_PER_USER_CAP_USD },
  schemaVersion: 1,
};

// ─── B — Flat-grant value gradient (ungated) ────────────────────────────────

export const SCENARIO_B_FLAT_2: ScenarioConfig = {
  id: "B-flat-2",
  label: "B · $2 flat grant",
  description:
    "A leaner $2 ungated welcome grant. Cheapest per signup, but a smaller hook — less downstream retention per claimant.",
  grant: { kind: "flat_grant", grantUsd: 2, perUserCapUsd: BASELINE_PER_USER_CAP_USD },
  schemaVersion: 1,
};

export const SCENARIO_B_FLAT_3: ScenarioConfig = {
  id: "B-flat-3",
  label: "B · $3 flat grant",
  description:
    "A $3 ungated welcome grant — a modest trim of the baseline. Slightly cheaper, slightly weaker hook.",
  grant: { kind: "flat_grant", grantUsd: 3, perUserCapUsd: BASELINE_PER_USER_CAP_USD },
  schemaVersion: 1,
};

export const SCENARIO_B_FLAT_7: ScenarioConfig = {
  id: "B-flat-7",
  label: "B · $7 flat grant",
  description:
    "A richer $7 ungated welcome grant. A stronger hook (more retention headroom) at a higher cost per signup — and more leakage to abuse, since it is ungated.",
  grant: { kind: "flat_grant", grantUsd: 7, perUserCapUsd: BASELINE_PER_USER_CAP_USD },
  schemaVersion: 1,
};

export const SCENARIO_B_FLAT_10: ScenarioConfig = {
  id: "B-flat-10",
  label: "B · $10 flat grant",
  description:
    "A generous $10 ungated welcome grant. Maximum hook, maximum cost — and the most exposed to multi-account farming without a gate.",
  grant: { kind: "flat_grant", grantUsd: 10, perUserCapUsd: BASELINE_PER_USER_CAP_USD },
  schemaVersion: 1,
};

export const SCENARIO_B_FLAT_15: ScenarioConfig = {
  id: "B-flat-15",
  label: "B · $15 flat grant",
  description:
    "An aggressive $15 ungated welcome grant. The loosest acquisition push in the library — strong conversion pull but the highest abuse exposure and cost.",
  grant: { kind: "flat_grant", grantUsd: 15, perUserCapUsd: BASELINE_PER_USER_CAP_USD },
  schemaVersion: 1,
};

// ─── C — Deposit-gated (the anti-abuse lever) ───────────────────────────────

export const SCENARIO_C_GATED_1: ScenarioConfig = {
  id: "C-gated-1",
  label: "C · $5 grant · $1 deposit gate",
  description:
    "The baseline $5 grant, but UNLOCKED only after a $1 qualifying first deposit. The lightest gate — barely any friction for genuine users, yet bonus-only farmers (who never deposit) drop out entirely. The single most effective signup-bonus anti-abuse lever.",
  grant: { kind: "deposit_gated", grantUsd: 5, perUserCapUsd: BASELINE_PER_USER_CAP_USD, minDepositUsd: 1 },
  schemaVersion: 1,
};

export const SCENARIO_C_GATED_5: ScenarioConfig = {
  id: "C-gated-5",
  label: "C · $5 grant · $5 deposit gate",
  description:
    "The $5 grant unlocked after a $5 first deposit (match the grant). Stronger screen than the $1 gate — filters more low-intent signups while still rewarding genuine first-depositors.",
  grant: { kind: "deposit_gated", grantUsd: 5, perUserCapUsd: BASELINE_PER_USER_CAP_USD, minDepositUsd: 5 },
  schemaVersion: 1,
};

export const SCENARIO_C_GATED_10: ScenarioConfig = {
  id: "C-gated-10",
  label: "C · $7 grant · $10 deposit gate",
  description:
    "A richer $7 grant gated behind a $10 first deposit. Pays MORE to genuine depositors while the gate keeps the paid population almost entirely first-time depositors — leakage collapses, but the gate deters some marginal genuine signups.",
  grant: { kind: "deposit_gated", grantUsd: 7, perUserCapUsd: BASELINE_PER_USER_CAP_USD, minDepositUsd: 10 },
  schemaVersion: 1,
};

export const SCENARIO_C_GATED_20: ScenarioConfig = {
  id: "C-gated-20",
  label: "C · $10 grant · $20 deposit gate",
  description:
    "A generous $10 grant gated behind a $20 first deposit. The strictest gate in the library — near-zero abuse leakage and only genuine, higher-intent depositors paid, at the cost of the most deterred genuine conversion (highest friction).",
  grant: { kind: "deposit_gated", grantUsd: 10, perUserCapUsd: BASELINE_PER_USER_CAP_USD, minDepositUsd: 20 },
  schemaVersion: 1,
};

// ─── D — Tiered / level-up ──────────────────────────────────────────────────

export const SCENARIO_D_TIERED_LIGHT: ScenarioConfig = {
  id: "D-tiered-light",
  label: "D · Tiered ($2 + 3×$2)",
  description:
    "A $2 instant welcome grant plus 3 level-up tranches of $2 each, earned by wagering. Most of the cost lands on users who actually play (engaged + FTD cohorts), so dormant and abuse claimants only ever cost the small instant grant. Shifts spend toward genuine engagement.",
  grant: {
    kind: "tiered_levelup",
    instantGrantUsd: 2,
    levelTranches: 3,
    trancheUsd: 2,
    perUserCapUsd: BASELINE_PER_USER_CAP_USD,
  },
  schemaVersion: 1,
};

export const SCENARIO_D_TIERED_RICH: ScenarioConfig = {
  id: "D-tiered-rich",
  label: "D · Tiered ($3 + 4×$3)",
  description:
    "A $3 instant welcome grant plus 4 level-up tranches of $3 each (up to $15 fully leveled). A richer engagement ladder — generous to players who climb it, while dormant/abuse claimants still only cost the $3 instant grant.",
  grant: {
    kind: "tiered_levelup",
    instantGrantUsd: 3,
    levelTranches: 4,
    trancheUsd: 3,
    perUserCapUsd: BASELINE_PER_USER_CAP_USD,
  },
  schemaVersion: 1,
};

// ─── E — Dynamic per-segment (smart targeting) ──────────────────────────────

export const SCENARIO_E_DYNAMIC: ScenarioConfig = {
  id: "E-dynamic",
  label: "E · Dynamic per-segment",
  description:
    "Per-segment grant sizing, ungated: generous to FTD-likely cohorts (high-value $12 / low-value $8) and the engaged free-players ($6, who may convert), tiny to dormant ($2) and multi-account abuse ($1). Concentrates spend where it retains, starves it where it leaks — without a deposit gate's friction.",
  grant: {
    kind: "dynamic_segment",
    perSegmentGrantUsd: {
      ftd_high_value: 12,
      ftd_low_value: 8,
      engaged_no_deposit: 6,
      dormant_no_deposit: 2,
      multi_account_abuse: 1,
    },
    perUserCapUsd: BASELINE_PER_USER_CAP_USD,
    minDepositUsd: 0,
  },
  schemaVersion: 1,
};

export const SCENARIO_E_DYNAMIC_GATED: ScenarioConfig = {
  id: "E-dynamic-gated",
  label: "E · Dynamic + $5 gate",
  description:
    "The dynamic per-segment grant PLUS a $5 deposit gate — the most targeted policy in the library. Generous per-segment sizing for genuine cohorts, but every grant unlocked by a qualifying deposit: spend lands almost entirely on real first-depositors, leakage is minimal. The highest-complexity, lowest-leakage option.",
  grant: {
    kind: "dynamic_segment",
    perSegmentGrantUsd: {
      ftd_high_value: 12,
      ftd_low_value: 8,
      engaged_no_deposit: 6,
      dormant_no_deposit: 2,
      multi_account_abuse: 1,
    },
    perUserCapUsd: BASELINE_PER_USER_CAP_USD,
    minDepositUsd: 5,
  },
  schemaVersion: 1,
};

// ─── Library aggregate ────────────────────────────────────────────────────────

/** The full shippable scenario library (A–E), baseline first. */
export const SCENARIO_LIBRARY: ScenarioConfig[] = [
  // A — baseline (always row 0)
  SCENARIO_A_BASELINE,
  // B — flat-grant value gradient ($2 → $15, ungated)
  SCENARIO_B_FLAT_2,
  SCENARIO_B_FLAT_3,
  SCENARIO_B_FLAT_7,
  SCENARIO_B_FLAT_10,
  SCENARIO_B_FLAT_15,
  // C — deposit-gated (the anti-abuse lever)
  SCENARIO_C_GATED_1,
  SCENARIO_C_GATED_5,
  SCENARIO_C_GATED_10,
  SCENARIO_C_GATED_20,
  // D — tiered / level-up
  SCENARIO_D_TIERED_LIGHT,
  SCENARIO_D_TIERED_RICH,
  // E — dynamic per-segment (smart targeting)
  SCENARIO_E_DYNAMIC,
  SCENARIO_E_DYNAMIC_GATED,
];

// ─── Gated what-if set (the comparison-table rows) ──────────────────────────

/**
 * Explicit deposit-gate comparison set. Row 0 is the baseline (ungated $5) so
 * the table's savings columns are populated relative to the current policy. The
 * gated rows form a clean gate-strength gradient ($1 → $20 unlock) so the table
 * shows how cost, leakage and friction move as the gate tightens — alongside the
 * leanest tiered + most-targeted dynamic variants for contrast.
 */
export const GATED_WHATIF_SET: ScenarioConfig[] = [
  SCENARIO_A_BASELINE,
  // Deposit-gate gradient ($1 → $20 unlock)
  SCENARIO_C_GATED_1,
  SCENARIO_C_GATED_5,
  SCENARIO_C_GATED_10,
  SCENARIO_C_GATED_20,
  // Structural alternatives to a hard gate
  SCENARIO_D_TIERED_LIGHT,
  SCENARIO_E_DYNAMIC,
  SCENARIO_E_DYNAMIC_GATED,
];

/** The id of the reference (baseline) scenario shared by both sets. */
export const BASELINE_SCENARIO_ID = SCENARIO_A_BASELINE.id;
