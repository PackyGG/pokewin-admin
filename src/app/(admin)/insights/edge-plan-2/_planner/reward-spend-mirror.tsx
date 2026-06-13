"use client";

import * as React from "react";

import { formatCurrency } from "@/lib/utils/format";
import {
  RewardSpendPanel,
  type RewardSpendRow,
} from "../../reward-spend-panel";
import type { EdgePlanV2Baseline, WagerScenarioView } from "../_model-v2";

/**
 * Compact mirror of the /insights hub "Reward spend" box, fed from the
 * LIVE projection through the wager-scenario view: planned $ per program +
 * its drag in percentage points (planned $ ÷ hub wager — the OWNER drag
 * model, same denominator as the owner-anchor strip's on-site drag). Every
 * lever move re-renders the planned $ and the drag chip, so the owner SEES
 * each program's cost move.
 *
 * SCENARIO-AWARE (owner fix 2026-06-12): the rows read from
 * `scenario.levers` (`applyWagerScenarioV2`), so the 1×–5× wager chips move
 * this box too — rakeback / affiliate / shards scale $ with the multiplier,
 * fixed-window $ budgets hold flat (their drag dilutes), and the drag
 * denominator is the hub wager × the multiplier. At 1× the rows are the
 * exact base projection (identity); at any other multiplier the window
 * label and every row note are LOUDLY marked "at N× wager".
 *
 * Rows: the 11 owner programs always (even at $0 planned, so the dropdown
 * enum matches the hub box), plus any other live planner cost row
 * (counted adjustments, residual other, shards, crediting-matrix savings)
 * while it is non-zero — Σ INCLUDED rows = the scenario's planned reward
 * cost, so the total chip equals the planner's headline drag by
 * construction. Owner-excluded programs (spec #14, counts-toward-edge OFF)
 * keep their row — $ still displayed — but are LOUDLY marked: "(excluded
 * from edge)" label, neutral "— edge" chip instead of a drag chip, a note
 * carrying the would-be drag, and a footnote line listing them; they are in
 * NONE of this box's totals (matching the projection partition). Affiliate
 * leaderboard prizes stay a creator-cost footnote (house model).
 */

/** The 11 owner-program lever keys — always shown, mirroring the hub enum. */
const PROGRAM_LEVER_KEYS = new Set([
  "rakeback",
  "affiliate",
  "deposit-bonus",
  "races",
  "raffles",
  "daily-packs",
  "signup-packs",
  "rain",
  "motha",
  "gift-cards",
  "promo-codes",
]);

export function RewardSpendMirror({
  baseline,
  scenario,
  creatorLeaderboardCostUsd,
}: {
  baseline: EdgePlanV2Baseline;
  /** The whole planning view at the active wager multiplier (1× = base). */
  scenario: WagerScenarioView;
  /** Creator-attributed leaderboard prizes (footnote passthrough). */
  creatorLeaderboardCostUsd: number;
}) {
  const recon = baseline.recon.d30;
  const wager = Math.max(0, scenario.hubWager);
  const { active, multLabel } = scenario;

  const rows = React.useMemo<RewardSpendRow[]>(
    () =>
      scenario.levers
        .filter(
          (l) =>
            PROGRAM_LEVER_KEYS.has(l.key) || Math.abs(l.plannedCost) > 0.005,
        )
        .map((l) => {
          const baseNote = active
            ? `Planned window $ at the current levers, at ${multLabel} wager (${
                l.scalesWithWager
                  ? "scales with wager"
                  : "fixed-window budget — held flat"
              }; was ${formatCurrency(l.baseCurrentCost)} measured at 1×). Drag = planned $ ÷ hub wager × ${multLabel} (${recon.label}).`
            : `Planned window $ at the current levers (was ${formatCurrency(l.currentCost)} measured). Drag = planned $ ÷ hub wager (${recon.label}).`;
          if (l.includedInEdge) {
            return {
              key: l.key,
              label: l.label,
              amountUsd: l.plannedCost,
              edgeReductionPp: wager > 0 ? (l.plannedCost / wager) * 100 : null,
              note: baseNote,
            };
          }
          // Owner-excluded (spec #14): $ stays displayed, drag chip goes
          // neutral ("— edge"), the would-be drag moves into the note, and
          // the row is in NONE of the totals below.
          const wouldBePp = wager > 0 ? (l.plannedCost / wager) * 100 : null;
          return {
            key: l.key,
            label: `${l.label} (excluded from edge)`,
            amountUsd: l.plannedCost,
            edgeReductionPp: null,
            note: `OWNER-EXCLUDED from edge attribution (counts-toward-edge OFF): this $ is still real spend but is in NONE of this box's totals or the planner's drag / NGR figures${
              wouldBePp != null
                ? ` — its would-be drag is ${wouldBePp.toFixed(wouldBePp > 0 && wouldBePp < 0.01 ? 3 : 2)}%`
                : ""
            }. ${baseNote}`,
          };
        }),
    [scenario.levers, wager, recon.label, active, multLabel],
  );

  // Σ INCLUDED rows by construction — the projection partition (spec #14)
  // already keeps owner-excluded rows out of this total.
  const plannedTotal = scenario.plannedRewardCost;
  const excludedRows = React.useMemo(
    () => scenario.levers.filter((l) => !l.includedInEdge),
    [scenario.levers],
  );
  const excludedNote =
    excludedRows.length > 0
      ? ` Owner-excluded from edge attribution (counts-toward-edge OFF): ${excludedRows
          .map((l) => `${l.label} ${formatCurrency(l.plannedCost)}`)
          .join(" · ")} — displayed above, in NONE of this box's totals.`
      : "";

  return (
    <RewardSpendMirrorView
      rows={rows}
      windowLabel={`${recon.label} · planned${active ? ` · at ${multLabel} wager` : ""}`}
      totalUsd={plannedTotal}
      totalPp={wager > 0 ? (plannedTotal / wager) * 100 : null}
      totalLabel={
        active
          ? `planned on-site reward cost at ${multLabel} wager · moves with the levers`
          : "planned on-site reward cost · moves with the levers"
      }
      creatorLeaderboardUsd={creatorLeaderboardCostUsd}
      scenarioNote={`${excludedNote}${
        active
          ? ` Scenario ${multLabel}: rakeback / affiliate / shards scale $ with wager, fixed-window budgets hold flat; drag = $ ÷ hub wager × ${multLabel}.`
          : ""
      }`}
    />
  );
}

function RewardSpendMirrorView({
  rows,
  windowLabel,
  totalUsd,
  totalPp,
  totalLabel,
  creatorLeaderboardUsd,
  scenarioNote,
}: {
  rows: RewardSpendRow[];
  windowLabel: string;
  totalUsd: number;
  totalPp: number | null;
  totalLabel: string;
  creatorLeaderboardUsd: number;
  scenarioNote: string;
}) {
  return (
    <RewardSpendPanel
      compact
      title="Reward spend — live plan"
      windowLabel={windowLabel}
      rows={rows}
      totalUsd={totalUsd}
      totalPp={totalPp}
      totalLabel={totalLabel}
      footnote={`Mirrors the /insights hub Reward-spend box on the live plan: planned $ per program ÷ hub wager. Creator costs not in this drag: affiliate leaderboard prizes ${formatCurrency(creatorLeaderboardUsd)} (attributed to Creators per the house model).${scenarioNote}`}
    />
  );
}
