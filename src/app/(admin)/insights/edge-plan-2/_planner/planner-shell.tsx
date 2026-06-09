"use client";

import * as React from "react";
import {
  Coins,
  Gauge,
  Percent,
  RotateCcw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { KpiTile } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import { formatCompactUsd } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../../edge-calc/math";
import { computeNetEdgeScenarios } from "../../system-edge-plan/_model";
import {
  defaultLeversV2,
  projectEdgePlanV2,
  sanitizeLeversV2,
  computeEdgeAfterRewards,
  computeBlendedEdgeBreakdownV2,
  resolveScenarioWagerUsd,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
  type WagerScenarioState,
} from "../_model-v2";
import {
  leversEqualV2,
  PlannerPresetsV2,
  usePlannerPresetsV2,
  type SavedConfigV2,
} from "../_presets-v2";
import {
  PlannerV2SectionNav,
  PlannerV2SectionPanel,
  type PlannerV2SectionId,
} from "./planner-nav";
import { EMERALD, ROSE } from "./utils";
import { OverviewSection } from "./sections/overview";
import { GamingEdgeSection, makeGamingSetters } from "./sections/gaming-edge";
import { RewardsCoreSection } from "./sections/rewards-core";
import { ShardsEconomySection } from "./sections/shards-economy";
import { WithdrawalsSection } from "./sections/withdrawals";
import { PacksSignupSection } from "./sections/packs-signup";
import { IdeasSection } from "./sections/ideas";

function toV1LeversForNetEdge(levers: PlannedLeversV2) {
  return {
    ...levers,
    rafflePrizePoolMult: 1,
    raffleFrequencyMult: 1,
    raffleTicketCostMult: 1,
  };
}

function toV1BaselineForNetEdge(baseline: EdgePlanV2Baseline) {
  return { ...baseline, raffleCost: 0 };
}

export function EdgePlanV2Planner({ baseline }: { baseline: EdgePlanV2Baseline }) {
  const [activeSection, setActiveSection] =
    React.useState<PlannerV2SectionId>("overview");
  const [levers, setLevers] = React.useState<PlannedLeversV2>(() =>
    defaultLeversV2(baseline),
  );
  const [wagerScenario, setWagerScenario] = React.useState<WagerScenarioState>({
    presetMult: 1,
  });

  const projection = React.useMemo(
    () => projectEdgePlanV2(baseline, levers),
    [baseline, levers],
  );

  const netEdgeScenarios = React.useMemo(
    () => computeNetEdgeScenarios(toV1BaselineForNetEdge(baseline), toV1LeversForNetEdge(levers)),
    [baseline, levers],
  );

  const edgeAfterRewards = React.useMemo(() => {
    const baseWager = Math.max(0, projection.plannedWager || projection.currentWager);
    const scenarioWagerUsd = resolveScenarioWagerUsd(baseWager, wagerScenario);
    return computeEdgeAfterRewards(projection, {
      baseline,
      levers,
      scenarioWagerUsd,
    });
  }, [projection, baseline, levers, wagerScenario]);

  const blendBreakdown = React.useMemo(
    () => computeBlendedEdgeBreakdownV2(baseline, levers),
    [baseline, levers],
  );

  const defaults = React.useMemo(() => defaultLeversV2(baseline), [baseline]);
  const gaming = React.useMemo(() => makeGamingSetters(setLevers), []);
  const presets = usePlannerPresetsV2();

  const dirtyVsActive = React.useMemo(() => {
    const ref = presets.activeConfig
      ? sanitizeLeversV2(presets.activeConfig.levers)
      : defaults;
    return !leversEqualV2(levers, ref);
  }, [levers, presets.activeConfig, defaults]);

  const handleLoadConfig = React.useCallback((cfg: SavedConfigV2) => {
    setLevers(sanitizeLeversV2(cfg.levers));
  }, []);

  const profitTone = projection.profitDelta >= 0 ? EMERALD : ROSE;
  const netEdgeTone =
    edgeAfterRewards.netEdgeAfterRewards < 0
      ? ROSE
      : edgeAfterRewards.netEdgeAfterRewards < 0.02
        ? "#f59e0b"
        : EMERALD;

  return (
    <div className="space-y-4">
      {baseline.baselineSparse && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
          Some 30d baseline reads were unavailable — wager and reward anchors may
          be partially estimated. Levers and saved configs still work for what-if
          planning.
        </div>
      )}
      <div className="flex flex-col gap-3 rounded-xl border bg-gradient-to-br from-violet-500/10 via-card to-card p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Projected profit delta
          </p>
          <p className={`text-3xl font-bold tabular-nums ${profitTone}`}>
            {formatSignedUsd(projection.profitDelta)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatSignedUsd(projection.monthlyProfitDelta)}/mo ·{" "}
            {formatSignedUsd(projection.annualProfitDelta)}/yr extrapolated
          </p>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Current NGR
              </p>
              <p className="font-semibold tabular-nums">
                {formatCompactUsd(projection.currentNgr)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Planned NGR
              </p>
              <p className={`font-semibold tabular-nums ${profitTone}`}>
                {formatCompactUsd(projection.plannedNgr)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Edge before rewards
              </p>
              <p className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatPct(edgeAfterRewards.grossEdge)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                was {formatPct(edgeAfterRewards.currentGrossEdge)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Edge after rewards
              </p>
              <p className="font-semibold tabular-nums" style={{ color: netEdgeTone }}>
                {formatPct(edgeAfterRewards.netEdgeAfterRewards)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                was {formatPct(edgeAfterRewards.currentNetEdge)}
                {edgeAfterRewards.netEdgeDelta !== 0 && (
                  <>
                    {" "}
                    · {edgeAfterRewards.netEdgeDelta >= 0 ? "+" : ""}
                    {formatPct(edgeAfterRewards.netEdgeDelta)}
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setLevers(defaults)}>
            <RotateCcw className="size-3.5" />
            Reset
          </Button>
          <PlannerPresetsV2
            presets={presets}
            currentLevers={levers}
            dirtyVsActive={dirtyVsActive}
            onLoad={handleLoadConfig}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">
        <KpiTile
          label="Before rewards"
          value={formatPct(edgeAfterRewards.grossEdge)}
          sub={`all wager · ${formatPct(blendBreakdown.marginBearingBlendedEdge)} packs+upg`}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="After rewards"
          value={formatPct(edgeAfterRewards.netEdgeAfterRewards)}
          sub={`−${formatPct(edgeAfterRewards.plannedRewardDrag)} drag`}
          icon={Percent}
          accent={
            edgeAfterRewards.netEdgeAfterRewards < 0
              ? "rose"
              : edgeAfterRewards.netEdgeAfterRewards < 0.02
                ? "amber"
                : "cyan"
          }
        />
        <KpiTile
          label="Organic wager"
          value={formatCompactUsd(projection.plannedWager)}
          sub="No creator code · borrow incl. · observed volume"
          icon={Coins}
          accent="blue"
        />
        <KpiTile
          label="Planned GGR"
          value={formatCompactUsd(projection.plannedGgr)}
          sub={`${formatPct(blendBreakdown.allWagerBlendedEdge)} all wager · ${formatPct(blendBreakdown.marginBearingBlendedEdge)} packs+upg`}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Reward cost"
          value={formatCompactUsd(projection.plannedRewardCost)}
          sub={formatSignedUsd(projection.rewardCostDelta)}
          icon={Wallet}
          accent="rose"
        />
        <KpiTile
          label="Planned NGR"
          value={formatCompactUsd(projection.plannedNgr)}
          sub={`${formatSignedUsd(projection.profitDelta)} vs current`}
          icon={Gauge}
          accent="cyan"
        />
        <KpiTile
          label="GGR delta"
          value={formatSignedUsd(projection.ggrDelta)}
          sub="vs planning defaults"
          icon={TrendingDown}
          accent={projection.ggrDelta >= 0 ? "emerald" : "rose"}
        />
      </div>

      <PlannerV2SectionNav
        active={activeSection}
        onChange={setActiveSection}
        className="sticky top-0 z-10 backdrop-blur-md supports-[backdrop-filter]:bg-background/80"
      />

      <PlannerV2SectionPanel id="overview" active={activeSection}>
        <OverviewSection
          projection={projection}
          netEdgeScenarios={netEdgeScenarios}
          baseline={baseline}
          levers={levers}
          wagerScenario={wagerScenario}
          onWagerScenarioChange={setWagerScenario}
        />
      </PlannerV2SectionPanel>
      <PlannerV2SectionPanel id="gaming" active={activeSection}>
        <GamingEdgeSection
          baseline={baseline}
          levers={levers}
          setPacksEdge={gaming.setPacksEdge}
          setUpgraderEdge={gaming.setUpgraderEdge}
        />
      </PlannerV2SectionPanel>
      <PlannerV2SectionPanel id="rewards" active={activeSection}>
        <RewardsCoreSection
          baseline={baseline}
          levers={levers}
          projection={projection}
          setLevers={setLevers}
        />
      </PlannerV2SectionPanel>
      <PlannerV2SectionPanel id="shards" active={activeSection}>
        <ShardsEconomySection
          baseline={baseline}
          levers={levers}
          projection={projection}
          setLevers={setLevers}
        />
      </PlannerV2SectionPanel>
      <PlannerV2SectionPanel id="withdrawals" active={activeSection}>
        <WithdrawalsSection
          baseline={baseline}
          levers={levers}
          projection={projection}
          setLevers={setLevers}
        />
      </PlannerV2SectionPanel>
      <PlannerV2SectionPanel id="packs" active={activeSection}>
        <PacksSignupSection
          baseline={baseline}
          levers={levers}
          projection={projection}
          setLevers={setLevers}
        />
      </PlannerV2SectionPanel>
      <PlannerV2SectionPanel id="ideas" active={activeSection}>
        <IdeasSection />
      </PlannerV2SectionPanel>
    </div>
  );
}
