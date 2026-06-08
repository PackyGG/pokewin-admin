"use client";

import * as React from "react";
import { Gauge } from "lucide-react";

import { StatPanel } from "@/components/modern-panels";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
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

  return (
    <StatPanel title="House edge" icon={Gauge} accent="emerald">
      <p className="mb-4 text-xs text-muted-foreground">
        Packs & battles share one edge lever; upgrader is separate. Sliders open on
        planning defaults with measured edge shown as reference.
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
            preciseInput={{ unit: "percent", decimals: 2 }}
          />
          {packsBattles.map((g) => (
            <p key={g.type} className="text-[11px] text-muted-foreground">
              {g.type}: measured {g.edge != null ? formatPct(g.edge) : "—"} · wager{" "}
              {g.wager.toLocaleString()}
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
            disabled={!upgrader?.dataAvailable}
            preciseInput={{ unit: "percent", decimals: 2 }}
          />
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
