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
  rawMathEdgeV2,
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
  const rawEdge = rawMathEdgeV2(levers);

  return (
    <StatPanel title="House edge" icon={Gauge} accent="emerald">
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        In plain words: Edge = % of every bet we keep — the two sliders below
        set it for packs and upgrader.
      </p>
      {/* ── Dual edge readout: raw math vs wager-weighted (both labeled) ── */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0 rounded-lg border bg-background/40 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Raw math edge
          </p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-foreground">
            {formatPct(rawEdge)}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            In plain words: simple average of the two sliders, no volumes
            ({formatPct(packsEdge)} &amp; {formatPct(upgraderEdge)} — no wager
            weighting).
          </p>
        </div>
        <div className="min-w-0 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            Wager-weighted edge
          </p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-foreground">
            {formatPct(blendBreakdown.marginBearingBlendedEdge)}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            In plain words: the same edge counted where the money actually
            goes. Weighted by the real 30d packs + upgrader wager mix ·{" "}
            {formatPct(blendBreakdown.allWagerBlendedEdge)} on all wager.
          </p>
        </div>
      </div>

      <BlendedEdgeBreakdownPanel breakdown={blendBreakdown} />
      <p className="mb-4 mt-4 text-xs leading-relaxed text-muted-foreground">
        House edge is on <strong>pack opens</strong> — including pack opens inside
        battles, which are already counted under Packs. Battle bets carry{" "}
        <strong>no separate edge</strong>: their GGR is realized via those packs, so
        battles are merged into the Packs line. The edge sliders default to the{" "}
        <strong>planning targets</strong> (packs + battles 10.99%, upgrader 10%) — dial
        them to plan a different edge. GGR is edge × wager volume.
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

          <div className="rounded-lg border bg-background/40 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Swords className="size-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">Battles</span>
              <Badge variant="outline" className="text-[10px]">
                Merged into Packs
              </Badge>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Pack opens inside battles use the packs edge above and are already
              counted under Packs. Battle entry stakes carry no separate edge — there
              is no battle-only margin to set; GGR is realized via the packs opened.
            </p>
            {battles && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                wager {formatCompactUsd(battles.wager)} · GGR realized via packs
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
