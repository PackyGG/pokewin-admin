"use client";

import { Layers, Wallet } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../../../edge-calc/math";
import { cn } from "@/lib/utils";
import {
  computeEdgeAfterRewards,
  resolveScenarioWagerUsd,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
  type WagerScenarioState,
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
  wagerScenario,
  onWagerScenarioChange,
}: {
  projection: EdgePlanV2Projection;
  netEdgeScenarios: NetEdgeScenario[];
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  wagerScenario: WagerScenarioState;
  onWagerScenarioChange: (next: WagerScenarioState) => void;
}) {
  const baseWager = Math.max(0, projection.plannedWager || projection.currentWager);
  const scenarioWagerUsd = resolveScenarioWagerUsd(baseWager, wagerScenario);
  const edgeAfterRewards = computeEdgeAfterRewards(projection, {
    baseline,
    levers,
    scenarioWagerUsd,
  });

  return (
    <div className="space-y-4">
      <EdgeAfterRewardsPanel
        summary={edgeAfterRewards}
        wagerScenario={wagerScenario}
        onWagerScenarioChange={onWagerScenarioChange}
      />
      <StatPanel title="GGR by game type" icon={Layers} accent="emerald">
        <div className="grid gap-3 sm:grid-cols-3">
          {projection.gameTypes
            .filter((g) => g.type !== "battles")
            .map((g) => (
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
                  {formatPct(g.plannedEdge)} edge · wager {formatCompactUsd(g.wager)}
                </div>
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  {formatCurrency(g.plannedGgr)} GGR
                </div>
              </div>
            ))}
          {(() => {
            const battles = projection.gameTypes.find((g) => g.type === "battles");
            if (!battles) return null;
            return (
              <div className="rounded-lg border border-dashed bg-background/40 px-3 py-2.5 space-y-1">
                <div className="text-sm font-medium">
                  {battles.label}
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                    Edge via packs · no separate battle margin
                  </span>
                </div>
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  wager {formatCompactUsd(battles.wager)} · pack opens in battles use packs
                  edge — not an extra layer on battle wager
                </div>
              </div>
            );
          })()}
        </div>
        <div className="mt-3 border-t pt-3 space-y-2">
          <PanelRow
            label="Total planned GGR"
            value={formatCurrency(projection.plannedGgr)}
          />
          {Math.abs(projection.ggrDelta) >= 0.005 && (
            <PanelRow
              label="GGR vs planning defaults"
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
          )}
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
