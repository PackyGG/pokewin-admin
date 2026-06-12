"use client";

import * as React from "react";

import { formatCurrency } from "@/lib/utils/format";
import {
  RewardSpendPanel,
  type RewardSpendRow,
} from "../../reward-spend-panel";
import type { EdgePlanV2Baseline, EdgePlanV2Projection } from "../_model-v2";

/**
 * Compact mirror of the /insights hub "Reward spend" box, fed from the
 * LIVE projection: planned $ per program + its drag in percentage points
 * (planned $ ÷ hub wager — the OWNER drag model, same denominator as the
 * owner-anchor strip's on-site drag). Every lever move re-renders the
 * planned $ and the drag chip, so the owner SEES each program's cost move.
 *
 * Rows: the 11 owner programs always (even at $0 planned, so the dropdown
 * enum matches the hub box), plus any other live planner cost row
 * (counted adjustments, residual other, shards, crediting-matrix savings)
 * while it is non-zero — Σ rows = the projection's planned reward cost,
 * so the total chip equals the planner's headline drag by construction.
 * Affiliate leaderboard prizes stay a creator-cost footnote (house model).
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
  projection,
}: {
  baseline: EdgePlanV2Baseline;
  projection: EdgePlanV2Projection;
}) {
  const recon = baseline.recon.d30;
  const wager = Math.max(0, recon.wager);

  const rows = React.useMemo<RewardSpendRow[]>(
    () =>
      projection.levers
        .filter(
          (l) =>
            PROGRAM_LEVER_KEYS.has(l.key) || Math.abs(l.plannedCost) > 0.005,
        )
        .map((l) => ({
          key: l.key,
          label: l.label,
          amountUsd: l.plannedCost,
          edgeReductionPp: wager > 0 ? (l.plannedCost / wager) * 100 : null,
          note: `Planned window $ at the current levers (was ${formatCurrency(l.currentCost)} measured). Drag = planned $ ÷ hub wager (${recon.label}).`,
        })),
    [projection.levers, wager, recon.label],
  );

  const plannedTotal = projection.plannedRewardCost;

  return (
    <RewardSpendMirrorView
      rows={rows}
      windowLabel={`${recon.label} · planned`}
      totalUsd={plannedTotal}
      totalPp={wager > 0 ? (plannedTotal / wager) * 100 : null}
      creatorLeaderboardUsd={projection.creatorLeaderboardCostUsd}
    />
  );
}

function RewardSpendMirrorView({
  rows,
  windowLabel,
  totalUsd,
  totalPp,
  creatorLeaderboardUsd,
}: {
  rows: RewardSpendRow[];
  windowLabel: string;
  totalUsd: number;
  totalPp: number | null;
  creatorLeaderboardUsd: number;
}) {
  return (
    <RewardSpendPanel
      compact
      title="Reward spend — live plan"
      windowLabel={windowLabel}
      rows={rows}
      totalUsd={totalUsd}
      totalPp={totalPp}
      totalLabel="planned on-site reward cost · moves with the levers"
      footnote={`Mirrors the /insights hub Reward-spend box on the live plan: planned $ per program ÷ hub wager. Creator costs not in this drag: affiliate leaderboard prizes ${formatCurrency(creatorLeaderboardUsd)} (attributed to Creators per the house model).`}
    />
  );
}
