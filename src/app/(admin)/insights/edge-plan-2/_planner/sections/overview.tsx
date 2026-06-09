"use client";

import { Layers, Wallet } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../../../edge-calc/math";
import { cn } from "@/lib/utils";
import {
  computeEdgeAfterRewards,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import type { NetEdgeScenario } from "../../../system-edge-plan/_model";
import {
  LeverBreakdownPanel,
  NetEdgeByScenarioPanel,
  RewardCostComparisonChart,
  EdgeAfterRewardsPanel,
} from "../components/overview-charts";

export function OverviewSection({
  projection,
  netEdgeScenarios,
  baseline,
  levers,
}: {
  projection: EdgePlanV2Projection;
  netEdgeScenarios: NetEdgeScenario[];
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
}) {
  const edgeAfterRewards = computeEdgeAfterRewards(projection, { baseline, levers });

  return (
    <div className="space-y-4">
      <EdgeAfterRewardsPanel summary={edgeAfterRewards} />
      <StatPanel title="GGR by game type" icon={Layers} accent="emerald">
        <div className="grid gap-3 sm:grid-cols-3">
          {projection.gameTypes.map((g) => {
            const up = g.ggrDelta >= 0;
            const tone =
              Math.abs(g.ggrDelta) < 0.005
                ? "text-muted-foreground"
                : up
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400";
            return (
              <div
                key={g.type}
                className="rounded-lg border bg-background/40 px-3 py-2.5 space-y-1"
              >
                <div className="text-sm font-medium">
                  {g.label}
                  {!g.dataAvailable && (
                    <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                      (no data)
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {g.type === "battles" ? (
                    <>
                      {formatPct(g.plannedEdge)} edge · 50/50 pack mode
                    </>
                  ) : (
                    <>
                      {formatPct(g.currentEdge)} → {formatPct(g.plannedEdge)} edge
                    </>
                  )}
                </div>
                <div className={cn("text-sm font-semibold tabular-nums", tone)}>
                  {Math.abs(g.ggrDelta) < 0.005 ? "—" : formatSignedUsd(g.ggrDelta)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 border-t pt-3">
          <PanelRow
            label="Total GGR change"
            value={
              <span
                className={cn(
                  projection.ggrDelta >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {formatSignedUsd(projection.ggrDelta)}
              </span>
            }
          />
        </div>
      </StatPanel>

      <NetEdgeByScenarioPanel scenarios={netEdgeScenarios} />
      <RewardCostComparisonChart projection={projection} />
      <LeverBreakdownPanel projection={projection} />

      <StatPanel title="Reward cost summary" icon={Wallet} accent="rose">
        <PanelRow label="Current reward cost" value={formatCurrency(projection.currentRewardCost)} />
        <PanelRow label="Planned reward cost" value={formatCurrency(projection.plannedRewardCost)} />
        <PanelRow
          label="Shard earn (planned)"
          value={formatCurrency(projection.shardsIssuancePlanned)}
        />
        <PanelRow
          label="Shard shop (planned)"
          value={formatCurrency(projection.shardsRedemptionPlanned)}
        />
      </StatPanel>
    </div>
  );
}
