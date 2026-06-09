"use client";

import * as React from "react";
import { Gauge, Swords } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatPanel } from "@/components/modern-panels";
import { formatCompactUsd } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import { effectiveProjectionTypeEdge } from "../../../system-edge-plan/_model";
import { formatPct } from "../../../edge-calc/math";
import {
  clamp,
  PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
  PLANNED_BATTLES_EDGE_DEFAULT,
  defaultPlannedEdge,
  computeBlendedEdgeBreakdownV2,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";
import { BlendedEdgeBreakdownPanel } from "../components/overview-charts";

type Props = {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  setPacksEdge: (pct: number) => void;
  setUpgraderEdge: (pct: number) => void;
};

export function GamingEdgeSection({
  baseline,
  levers,
  setPacksEdge,
  setUpgraderEdge,
}: Props) {
  const packs = baseline.gameTypes.find((g) => g.type === "packs");
  const battles = baseline.gameTypes.find((g) => g.type === "battles");
  const upgrader = baseline.gameTypes.find((g) => g.type === "upgrader");
  const packsEdge = levers.edges.packs ?? PLANNED_PACKS_BATTLES_EDGE_DEFAULT;
  const upgraderEdge = levers.edges.upgrader ?? defaultPlannedEdge("upgrader");
  const packsPlannedGgr = packs ? packsEdge * packs.wager : 0;
  const upgraderPlannedGgr = upgrader ? upgraderEdge * upgrader.wager : 0;
  const upgMeasured = upgrader
    ? effectiveProjectionTypeEdge(upgrader, baseline)
    : 0;
  const blendBreakdown = React.useMemo(
    () => computeBlendedEdgeBreakdownV2(baseline, levers),
    [baseline, levers],
  );

  return (
    <StatPanel title="House edge" icon={Gauge} accent="emerald">
      <BlendedEdgeBreakdownPanel breakdown={blendBreakdown} />
      <p className="mb-4 mt-4 text-xs leading-relaxed text-muted-foreground">
        House edge is on <strong>pack opens</strong> (10.99% planning default) — including
        pack opens inside battles. Battles are a game mode, not a separate margin layer;
        battle wager counts toward volume but adds <strong>0</strong> incremental GGR in
        projection. Sliders set the edge you plan around; GGR is edge × observed wager
        volume.
      </p>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="space-y-4">
          <div className="space-y-2">
            <LeverSlider
              label="Packs edge"
              valueLabel={formatPct(packsEdge)}
              value={packsEdge * 100}
              onValueChange={setPacksEdge}
              min={0}
              max={30}
              step={0.01}
              preciseInput={{ unit: "percent", decimals: 2 }}
            />
            {packs && (
              <p className="text-[11px] text-muted-foreground">
                {formatPct(packsEdge)} edge · wager {formatCompactUsd(packs.wager)} · GGR{" "}
                {formatCompactUsd(packsPlannedGgr)}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-dashed bg-background/40 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Swords className="size-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">Battles</span>
              <Badge variant="outline" className="text-[10px]">
                Edge via packs · no separate battle margin
              </Badge>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Pack opens in battles use the packs edge above — not an extra{" "}
              {formatPct(PLANNED_PACKS_BATTLES_EDGE_DEFAULT)} on battle wager. Planning
              edge locked at {formatPct(PLANNED_BATTLES_EDGE_DEFAULT)}.
            </p>
            {battles && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                wager {formatCompactUsd(battles.wager)} · observed GGR{" "}
                {formatCompactUsd(battles.ggr)} (ledger; not stacked in projection)
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <LeverSlider
            label="Upgrader edge"
            valueLabel={formatPct(levers.edges.upgrader ?? defaultPlannedEdge("upgrader"))}
            value={(levers.edges.upgrader ?? defaultPlannedEdge("upgrader")) * 100}
            onValueChange={setUpgraderEdge}
            min={0}
            max={30}
            step={0.01}
            baselineMarker={upgrader?.dataAvailable ? upgMeasured * 100 : undefined}
            baselineLabel={
              upgrader?.dataAvailable ? `measured ${formatPct(upgMeasured)}` : undefined
            }
            disabled={!upgrader?.dataAvailable}
            preciseInput={{ unit: "percent", decimals: 2 }}
          />
          {upgrader && (
            <div className="flex items-center gap-2">
              {!upgrader.dataAvailable && (
                <Badge variant="outline" className="text-[10px]">
                  no data
                </Badge>
              )}
              <p className="text-[11px] text-muted-foreground">
                {formatPct(upgraderEdge)} edge · wager {formatCompactUsd(upgrader.wager)}{" "}
                · planned GGR {formatCompactUsd(upgraderPlannedGgr)}
                {upgrader.dataAvailable && (
                  <> · observed GGR {formatCompactUsd(upgrader.ggr)}</>
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    </StatPanel>
  );
}

export function makeGamingSetters(
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>,
) {
  return {
    setPacksEdge: (pct: number) =>
      setLevers((s) => {
        const v = clamp(pct / 100, 0, 1);
        return {
          ...s,
          edges: { ...s.edges, packs: v, battles: PLANNED_BATTLES_EDGE_DEFAULT },
        };
      }),
    setUpgraderEdge: (pct: number) =>
      setLevers((s) => ({
        ...s,
        edges: { ...s.edges, upgrader: clamp(pct / 100, 0, 1) },
      })),
  };
}
