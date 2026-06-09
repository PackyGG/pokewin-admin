"use client";

import * as React from "react";
import { Gauge } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatPanel } from "@/components/modern-panels";
import { formatCompactUsd } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  blendedPackBattleEdge,
  effectiveProjectionTypeEdge,
} from "../../../system-edge-plan/_model";
import { formatPct } from "../../../edge-calc/math";
import {
  clamp,
  PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
  defaultPlannedEdge,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";

type Props = {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  setPacksBattlesEdge: (pct: number) => void;
  setUpgraderEdge: (pct: number) => void;
};

export function GamingEdgeSection({
  baseline,
  levers,
  setPacksBattlesEdge,
  setUpgraderEdge,
}: Props) {
  const packsBattles = baseline.gameTypes.filter(
    (g) => g.type === "packs" || g.type === "battles",
  );
  const upgrader = baseline.gameTypes.find((g) => g.type === "upgrader");
  const pbEdge = levers.edges.packs ?? PLANNED_PACKS_BATTLES_EDGE_DEFAULT;
  const pbMeasured = blendedPackBattleEdge(baseline);
  const upgMeasured = upgrader
    ? effectiveProjectionTypeEdge(upgrader, baseline)
    : 0;

  return (
    <StatPanel title="House edge" icon={Gauge} accent="emerald">
      <p className="mb-4 text-xs text-muted-foreground">
        Sliders open on planning defaults; measured edge ticks show the real 30d
        reference.
      </p>
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-2">
          <LeverSlider
            label="Packs & battles edge"
            valueLabel={formatPct(pbEdge)}
            value={pbEdge * 100}
            onValueChange={setPacksBattlesEdge}
            min={0}
            max={30}
            step={0.01}
            baselineMarker={pbMeasured * 100}
            baselineLabel={`measured ${formatPct(pbMeasured)}`}
            preciseInput={{ unit: "percent", decimals: 2 }}
          />
          {packsBattles.map((g) => (
            <p key={g.type} className="text-[11px] text-muted-foreground">
              {g.type}: measured {g.edge != null ? formatPct(g.edge) : "—"} · wager{" "}
              {formatCompactUsd(g.wager)} · GGR {formatCompactUsd(g.ggr)}
            </p>
          ))}
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
                wager {formatCompactUsd(upgrader.wager)} · GGR{" "}
                {formatCompactUsd(upgrader.ggr)}
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
    setPacksBattlesEdge: (pct: number) =>
      setLevers((s) => {
        const v = clamp(pct / 100, 0, 1);
        return { ...s, edges: { ...s.edges, packs: v, battles: v } };
      }),
    setUpgraderEdge: (pct: number) =>
      setLevers((s) => ({
        ...s,
        edges: { ...s.edges, upgrader: clamp(pct / 100, 0, 1) },
      })),
  };
}
