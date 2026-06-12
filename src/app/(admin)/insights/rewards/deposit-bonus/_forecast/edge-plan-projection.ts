/**
 * edge-plan-projection.ts — the SHARED Edge Plan 2.0 bridge into the
 * deposit-bonus forecast engine (owner spec #8, 2026-06-12). ADDITIVE: new
 * exports only — nothing existing in `_forecast/` changes.
 *
 * The Edge Plan time-based bonus block ("pay $X every N hours") is exactly a
 * SPLIT-WINDOW cap scenario on the forecast page (`$25/6h` → the `C-6h-25`
 * library scenario). This module runs THAT engine with THAT page's inputs:
 *
 *   • assumptions — `DEPOSIT_BONUS_FORECAST_CONFIG.defaults(realBaseline)`,
 *     the SAME live-derived assumptions builder the forecast island seeds
 *     from (claimant volume / claim probability / avg bonus anchored on the
 *     real overview read; behavioural levers at their named defaults),
 *   • scenario set — the real `A-baseline` ($100/24h) reference + the
 *     matching split-window scenario (the library object itself when the
 *     amount/interval matches one, so ids/labels line up),
 *   • anchor — `realBaseline.totalCost`, the SAME anchored scaling the
 *     island passes (`anchorBaselineCostUsd`), so the baseline scenario
 *     reads the real production cost exactly.
 *
 * Same engine + same assumptions + same anchor ⇒ the numbers here EQUAL the
 * forecast page's scenario row for the same assumptions snapshot, by
 * construction (the edge-plan `__checks__` pin the identity).
 *
 * PURE: no React, no DB, no server-only — safe in the client island's
 * `useMemo` and in the check harness.
 */

import type { ForecastBaseline } from "../../../_forecast-engine";
import { DEPOSIT_BONUS_FORECAST_CONFIG } from "./config";
import { simulateSet } from "./engine";
import {
  BASELINE_SCENARIO_ID,
  SCENARIO_A_BASELINE,
  SCENARIO_LIBRARY,
} from "./scenarios";
import type { Assumptions, ScenarioConfig } from "./types";

/**
 * Find the library scenario whose split-window cap matches the amount +
 * interval exactly (e.g. 25 + 6 → `C-6h-25`). Null when the inputs don't
 * correspond to a library entry — the caller synthesizes the same shape.
 */
export function findSplitCapLibraryScenario(
  amountUsd: number,
  intervalHours: number,
): ScenarioConfig | null {
  return (
    SCENARIO_LIBRARY.find(
      (s) =>
        s.cap.kind === "split_window" &&
        s.cap.capUsd === amountUsd &&
        s.cap.windowHours === intervalHours,
    ) ?? null
  );
}

/** The engine projection the Edge Plan time-bonus block headlines. */
export type SplitCapEngineProjection = {
  /** The scenario actually run (library id like "C-6h-25" or a synthesized one). */
  scenarioId: string;
  scenarioLabel: string;
  /** True when the inputs matched a forecast-page library scenario exactly. */
  matchedLibraryScenario: boolean;
  /** Engine horizon in days (the assumptions' windowDays — 30 by default). */
  horizonDays: number;
  /** Anchored baseline-policy ($100/24h) cost over the horizon — equals realBaseline.totalCost at the 30d default. */
  baselineCostUsd: number;
  /** The split-cap scenario's projected cost over the horizon. */
  scenarioCostUsd: number;
  /** GROSS savings vs the current baseline (the forecast table's savings column). */
  grossSavingsUsd: number;
  /** NET savings after retention/conversion loss — the honest headline. */
  netSavingsUsd: number;
  /** Gross/net savings scaled to a 30-day month. */
  monthlyGrossSavingsUsd: number;
  monthlyNetSavingsUsd: number;
  /** UX friction composite (0-100) of the split-cap policy. */
  frictionScore: number;
  /** The exact assumptions snapshot the engine ran with (transparency). */
  assumptions: Assumptions;
};

/**
 * Run baseline-vs-split-cap through the forecast engine. The two-scenario
 * set produces numbers IDENTICAL to the full-library run on the forecast
 * page: the anchored scaling depends only on the baseline scenario, and
 * each scenario's result depends only on its own cap + the shared
 * assumptions.
 */
export function projectSplitCapVsBaseline(
  realBaseline: ForecastBaseline,
  amountUsd: number,
  intervalHours: number,
): SplitCapEngineProjection {
  // THE same live-derived assumptions builder the forecast page island uses.
  const assumptions = DEPOSIT_BONUS_FORECAST_CONFIG.defaults(realBaseline);

  const amount = Math.max(0, Number.isFinite(amountUsd) ? amountUsd : 0);
  const interval = Math.min(
    720,
    Math.max(1, Number.isFinite(intervalHours) ? intervalHours : 24),
  );

  const matched = findSplitCapLibraryScenario(amount, interval);
  const scenario: ScenarioConfig =
    matched ?? {
      id: `edge-plan-split-${amount}-${interval}h`,
      label: `$${amount} / ${interval}h`,
      description: `Edge-plan time-based bonus what-if: $${amount} per rolling ${interval}h window — same engine and assumptions as /insights/forecast?reward=deposit-bonus.`,
      cap: { kind: "split_window", capUsd: amount, windowHours: interval },
      schemaVersion: 1,
    };

  const horizonDays = Math.max(1, Number(assumptions.windowDays) || 30);

  // Same call shape as the island: anchored on the REAL baseline total cost.
  const results = simulateSet(
    [SCENARIO_A_BASELINE, scenario],
    assumptions,
    { days: horizonDays },
    BASELINE_SCENARIO_ID,
    realBaseline.totalCost,
  );
  const base =
    results.find((r) => r.scenarioId === BASELINE_SCENARIO_ID) ?? results[0];
  const res =
    results.find((r) => r.scenarioId === scenario.id) ?? results[results.length - 1];

  const toMonthly = (usd: number): number => (usd / horizonDays) * 30;

  return {
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    matchedLibraryScenario: matched != null,
    horizonDays,
    baselineCostUsd: base.bonusCost,
    scenarioCostUsd: res.bonusCost,
    grossSavingsUsd: res.savingsVsBaseline,
    netSavingsUsd: res.netSavingsVsBaseline,
    monthlyGrossSavingsUsd: toMonthly(res.savingsVsBaseline),
    monthlyNetSavingsUsd: toMonthly(res.netSavingsVsBaseline),
    frictionScore: res.frictionScore,
    assumptions,
  };
}
