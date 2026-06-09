"use client";

import { cn } from "@/lib/utils";
import { formatPct } from "../../../edge-calc/math";
import {
  affiliateWorstCaseEdgeDrag,
  type EdgeAfterRewardsContext,
  type EdgePlanV2Projection,
} from "../../_model-v2";

function plannerWager(projection: EdgePlanV2Projection): number {
  return Math.max(0, projection.plannedWager || projection.currentWager);
}

/** Planned reward cost as a fraction of total wager (edge eroded). */
export function leverEdgeDragPct(
  projection: EdgePlanV2Projection,
  leverKey: string,
  ctx?: EdgeAfterRewardsContext,
): number {
  if (leverKey === "affiliate" && ctx) {
    return affiliateWorstCaseEdgeDrag(ctx.baseline, ctx.levers);
  }
  const wager = plannerWager(projection);
  if (wager <= 0) return 0;
  const lever = projection.levers.find((l) => l.key === leverKey);
  return lever ? lever.plannedCost / wager : 0;
}

/** Sum several levers' planned edge drag (e.g. rain + motha + other). */
export function combinedLeverEdgeDragPct(
  projection: EdgePlanV2Projection,
  leverKeys: string[],
): number {
  const wager = plannerWager(projection);
  if (wager <= 0) return 0;
  let cost = 0;
  for (const key of leverKeys) {
    const lever = projection.levers.find((l) => l.key === key);
    if (lever) cost += lever.plannedCost;
  }
  return cost / wager;
}

export function EdgeDragBadge({ dragPct }: { dragPct: number }) {
  if (!Number.isFinite(dragPct) || Math.abs(dragPct) < 0.00005) return null;
  const erodes = dragPct > 0;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums normal-case tracking-normal",
        erodes
          ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
          : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
      )}
    >
      {erodes ? `−${formatPct(dragPct)} edge` : `+${formatPct(Math.abs(dragPct))} edge`}
    </span>
  );
}

export function RewardPanelTitle({
  label,
  dragPct,
}: {
  label: string;
  dragPct: number;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="truncate">{label}</span>
      <EdgeDragBadge dragPct={dragPct} />
    </span>
  );
}
