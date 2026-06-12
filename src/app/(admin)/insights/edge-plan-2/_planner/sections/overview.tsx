"use client";

import { Layers, Wallet } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../../../edge-calc/math";
import { cn } from "@/lib/utils";
import type { EdgePlanV2Projection } from "../../_model-v2";
import type { NetEdgeScenario } from "../../../system-edge-plan/_model";
import { TEXT_TONE } from "../colors";
import {
  LeverBreakdownPanel,
  NetEdgeByScenarioPanel,
  RewardCostComparisonChart,
} from "../components/overview-charts";

/**
 * Bottom Analysis zone for the Edge Plan 2.0 planner.
 *
 * Always-on context that reflects the live planned config: GGR by game type,
 * the net-edge-by-scenario + reward-cost-comparison + cost-delta charts, and a
 * reward-cost summary. The gross→net edge waterfall lives in the hero now
 * (`EdgeAfterRewardsPanel` was merged there), so this zone is purely the
 * supporting analytics. House-POV finance colors via `../colors`.
 */
export function AnalysisZone({
  projection,
  netEdgeScenarios,
}: {
  projection: EdgePlanV2Projection;
  netEdgeScenarios: NetEdgeScenario[];
}) {
  // Reward-cost summary lines: every realized/planned reward leg the model
  // projects (rakeback + affiliate commission/leaderboard + deposit bonus +
  // races + raffles + daily packs + signup + rain + motha + other). The raffle
  // line is restored here in place of the removed shard rows.
  const summaryLines = projection.levers.filter(
    (l) => l.currentCost > 0 || l.plannedCost > 0,
  );

  return (
    <div className="space-y-4">
      <StatPanel title="GGR by game type" icon={Layers} accent="emerald">
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          In plain words: GGR = bets minus what players won back — split by
          game type.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {projection.gameTypes.map((g) => (
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
              {g.label === "Packs & battles" && (
                <div className="text-[10px] leading-snug text-muted-foreground/80">
                  Edge on pack opens, blended over pack + battle wager. Battle
                  stakes carry no separate edge — GGR is via the packs opened.
                </div>
              )}
              <div className="text-sm font-semibold tabular-nums text-foreground">
                {formatCurrency(g.plannedGgr)} GGR
              </div>
            </div>
          ))}
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
                    projection.ggrDelta >= 0 ? TEXT_TONE.emerald : TEXT_TONE.rose,
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
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          In plain words: everything we give away in rewards — today vs this
          plan, line by line.
        </p>
        <PanelRow
          label="Current reward cost"
          value={formatCurrency(projection.currentRewardCost)}
        />
        <PanelRow
          label="Planned reward cost"
          value={
            <span className={TEXT_TONE.rose}>
              {formatCurrency(projection.plannedRewardCost)}
            </span>
          }
        />
        <div className="mt-2 space-y-1 border-t pt-2">
          {summaryLines.map((l) => (
            <PanelRow
              key={l.key}
              label={l.label}
              value={
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatCompactUsd(l.currentCost)} → {formatCompactUsd(l.plannedCost)}
                </span>
              }
            />
          ))}
        </div>
      </StatPanel>
    </div>
  );
}
