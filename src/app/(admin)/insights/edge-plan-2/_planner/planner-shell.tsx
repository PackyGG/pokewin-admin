"use client";

import * as React from "react";
import { BarChart3, RotateCcw } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import { computeNetEdgeScenarios } from "../../system-edge-plan/_model";
import {
  defaultLeversV2,
  projectEdgePlanV2,
  sanitizeLeversV2,
  computeEdgeAfterRewards,
  computeBlendedEdgeBreakdownV2,
  resolveScenarioWagerUsd,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
  type WagerScenarioState,
} from "../_model-v2";
import {
  leversEqualV2,
  PlannerPresetsV2,
  usePlannerPresetsV2,
  type SavedConfigV2,
} from "../_presets-v2";
import { EdgePlanV2HeroSummary } from "./hero-summary";
import {
  LeverRail,
  leverGroupDragPct,
  type LeverGroupId,
} from "./lever-rail";
import { PlannerV2SectionPanel } from "./planner-nav";
import { AnalysisZone } from "./sections/overview";
import { GamingEdgeSection, makeGamingSetters } from "./sections/gaming-edge";
import { RewardsCoreSection } from "./sections/rewards-core";
import { RafflesSection } from "./sections/raffles";
import { WithdrawalsSection } from "./sections/withdrawals";
import { PacksSignupSection } from "./sections/packs-signup";

const DEFAULT_WAGER_SCENARIO: WagerScenarioState = { presetMult: 1 };

export function EdgePlanV2Planner({ baseline }: { baseline: EdgePlanV2Baseline }) {
  const [activeGroup, setActiveGroup] =
    React.useState<LeverGroupId>("gaming");
  const [levers, setLevers] = React.useState<PlannedLeversV2>(() =>
    defaultLeversV2(baseline),
  );
  const [wagerScenario, setWagerScenario] = React.useState<WagerScenarioState>(
    DEFAULT_WAGER_SCENARIO,
  );

  const projection = React.useMemo(
    () => projectEdgePlanV2(baseline, levers),
    [baseline, levers],
  );

  // Raffle cost is real reconstructed prize cost now (no longer a shard proxy),
  // so the net-edge scenarios run on the baseline + levers UNCHANGED — the
  // raffle row flows through the projection. PlannedLeversV2 / EdgePlanV2Baseline
  // extend the v1 shapes, so they are accepted by the v1 scenario helper.
  const netEdgeScenarios = React.useMemo(
    () => computeNetEdgeScenarios(baseline, levers),
    [baseline, levers],
  );

  const edgeAfterRewards = React.useMemo(() => {
    const baseWager = Math.max(
      0,
      projection.plannedWager ?? projection.currentWager ?? 0,
    );
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
    const active = presets.activeConfig;
    const refLevers = active ? sanitizeLeversV2(active.levers) : defaults;
    const leversDirty = !leversEqualV2(levers, refLevers);
    // Also treat a changed wager scenario as dirty so "Update" enables when
    // only the scenario moved (it is persisted alongside the levers).
    const refScenarioMult = active
      ? (active.wagerScenario?.presetMult ?? 1)
      : DEFAULT_WAGER_SCENARIO.presetMult;
    const scenarioDirty =
      Math.abs((wagerScenario.presetMult ?? 1) - refScenarioMult) > 0.0001;
    return leversDirty || scenarioDirty;
  }, [levers, wagerScenario, presets.activeConfig, defaults]);

  const handleLoadConfig = React.useCallback((cfg: SavedConfigV2) => {
    setLevers(sanitizeLeversV2(cfg.levers));
    setWagerScenario(cfg.wagerScenario ?? DEFAULT_WAGER_SCENARIO);
  }, []);

  const affiliateCtx = React.useMemo(
    () => ({ baseline, levers }),
    [baseline, levers],
  );

  // Live edge-drag per workspace for the rail badges (affiliate row needs the
  // worst-case tier ctx; the rest are plain wager-proportional rows).
  const dragByGroup = React.useMemo<Record<LeverGroupId, number>>(
    () => ({
      gaming: leverGroupDragPct(projection, "gaming", affiliateCtx),
      rewards: leverGroupDragPct(projection, "rewards", affiliateCtx),
      raffles: leverGroupDragPct(projection, "raffles", affiliateCtx),
      withdrawals: leverGroupDragPct(projection, "withdrawals", affiliateCtx),
      packs: leverGroupDragPct(projection, "packs", affiliateCtx),
    }),
    [projection, affiliateCtx],
  );

  const heroActions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setLevers(defaults);
          setWagerScenario(DEFAULT_WAGER_SCENARIO);
        }}
      >
        <RotateCcw className="size-3.5" />
        Reset
      </Button>
      <PlannerPresetsV2
        presets={presets}
        currentLevers={levers}
        currentWagerScenario={wagerScenario}
        dirtyVsActive={dirtyVsActive}
        onLoad={handleLoadConfig}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      {baseline.baselineSparse && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
          Some 30d baseline reads were unavailable — wager and reward anchors may
          be partially estimated. Levers and saved configs still work for what-if
          planning.
        </div>
      )}

      {/* ── Hero: profit delta + single edge waterfall + KPI strip ─────────── */}
      <EdgePlanV2HeroSummary
        projection={projection}
        edgeAfterRewards={edgeAfterRewards}
        blendBreakdown={blendBreakdown}
        wagerScenario={wagerScenario}
        onWagerScenarioChange={setWagerScenario}
        actions={heroActions}
      />

      {/* ── Lever rail + active-group workspace ────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:items-start">
        <LeverRail
          active={activeGroup}
          onSelect={setActiveGroup}
          dragByGroup={dragByGroup}
          className="lg:sticky lg:top-4"
        />

        <div className="min-w-0">
          <PlannerV2SectionPanel id="gaming" active={activeGroup}>
            <GamingEdgeSection
              baseline={baseline}
              levers={levers}
              setPacksEdge={gaming.setPacksEdge}
              setUpgraderEdge={gaming.setUpgraderEdge}
            />
          </PlannerV2SectionPanel>
          <PlannerV2SectionPanel id="rewards" active={activeGroup}>
            <RewardsCoreSection
              baseline={baseline}
              levers={levers}
              projection={projection}
              setLevers={setLevers}
            />
          </PlannerV2SectionPanel>
          <PlannerV2SectionPanel id="raffles" active={activeGroup}>
            <RafflesSection
              baseline={baseline}
              levers={levers}
              projection={projection}
              setLevers={setLevers}
            />
          </PlannerV2SectionPanel>
          <PlannerV2SectionPanel id="withdrawals" active={activeGroup}>
            <WithdrawalsSection
              baseline={baseline}
              levers={levers}
              projection={projection}
              setLevers={setLevers}
            />
          </PlannerV2SectionPanel>
          <PlannerV2SectionPanel id="packs" active={activeGroup}>
            <PacksSignupSection
              baseline={baseline}
              levers={levers}
              projection={projection}
              setLevers={setLevers}
            />
          </PlannerV2SectionPanel>
        </div>
      </div>

      {/* ── Analysis zone (always-on context + charts) ─────────────────────── */}
      <div className="space-y-4">
        <SectionHeading
          icon={BarChart3}
          title="Analysis"
          action={
            <span className="text-[11px] text-muted-foreground">
              Reflects the live planned config
            </span>
          }
        />
        <AnalysisZone
          projection={projection}
          netEdgeScenarios={netEdgeScenarios}
        />
      </div>
    </div>
  );
}
