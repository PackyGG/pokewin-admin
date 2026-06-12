"use client";

import * as React from "react";
import { BarChart3, Database, Landmark, RotateCcw } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatCompactUsd,
  formatCurrency,
  formatDateTime,
  formatNumber,
} from "@/lib/utils/format";
import { formatPct } from "../../edge-calc/math";
import {
  applyWagerScenarioV2,
  computeNetEdgeScenariosV2,
  computeOwnerDragSummary,
  defaultLeversV2,
  projectEdgePlanV2,
  rawMathEdgeV2,
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
import { TEXT_TONE } from "./colors";
import { EdgePlanV2HeroSummary } from "./hero-summary";
import { RewardSpendMirror } from "./reward-spend-mirror";
import {
  LEVER_GROUPS,
  LeverRail,
  leverGroupDragPct,
  type LeverGroupId,
} from "./lever-rail";
import { PlannerV2SectionPanel } from "./planner-nav";
import { AnalysisZone } from "./sections/overview";
import { GamingEdgeSection, makeGamingSetters } from "./sections/gaming-edge";
import { RewardsCoreSection } from "./sections/rewards-core";
import { GiveawaysSection } from "./sections/giveaways";
import { ShardsSection } from "./sections/shards";
import { PacksSignupSection } from "./sections/packs-signup";
import { CashflowSection } from "./sections/cashflow";
import { CreditMatrixSection } from "./sections/credit-matrix";

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

  // Net-edge scenario profiles (Analysis zone). The v2 lever state no longer
  // extends the v1 shape, so this goes through the model's own v1 bridge.
  const netEdgeScenarios = React.useMemo(
    () => computeNetEdgeScenariosV2(baseline, levers),
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

  // PAGE-WIDE wager scenario (owner fix: "wager amounts 1,2,3,4,5x dont
  // work") — ONE view of the whole projection at the active multiplier so
  // the hero, the KPI strip and the reward-spend mirror all move with the
  // chips. At 1× this is the exact base projection (identity).
  const scenario = React.useMemo(
    () => applyWagerScenarioV2(baseline, projection, wagerScenario),
    [baseline, projection, wagerScenario],
  );

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
  // worst-case tier ctx; cashflow/matrix surface their revenue/savings as a
  // negative drag → emerald badge). Built over LEVER_GROUPS so the record
  // can never miss a group id.
  const dragByGroup = React.useMemo<Record<LeverGroupId, number>>(() => {
    const out = {} as Record<LeverGroupId, number>;
    for (const g of LEVER_GROUPS) {
      out[g.id] = leverGroupDragPct(projection, g.id, affiliateCtx);
    }
    return out;
  }, [projection, affiliateCtx]);

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
      {baseline.degradedBlocks.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
          <span className="font-semibold">
            {baseline.degradedBlocks.length} non-critical baseline read
            {baseline.degradedBlocks.length === 1 ? "" : "s"} failed
          </span>{" "}
          ({baseline.degradedBlocks.join(", ")}) — the affected blocks plan
          from their fallback anchors (labeled estimated). All levers stay
          live; the headline numbers above are unaffected (owner-trusted
          stack).
        </div>
      )}

      {/* ── Owner-anchored headline (30d, hub helpers) + lifetime recon ───── */}
      <OwnerAnchorStrip baseline={baseline} projection={projection} />

      {/* ── Hero: profit delta + single edge waterfall + KPI strip —
             scenario-aware: the 1×–5× chips move EVERY $ figure here ── */}
      <EdgePlanV2HeroSummary
        scenario={scenario}
        edgeAfterRewards={edgeAfterRewards}
        blendBreakdown={blendBreakdown}
        rawMathEdge={rawMathEdgeV2(levers)}
        wagerScenario={wagerScenario}
        onWagerScenarioChange={setWagerScenario}
        actions={heroActions}
      />

      {/* ── Reward-spend mirror (compact) — planned $ + drag per program,
             live with every lever AND the wager-scenario chips; mirrors the
             /insights hub spend box ── */}
      <RewardSpendMirror
        baseline={baseline}
        scenario={scenario}
        creatorLeaderboardCostUsd={projection.creatorLeaderboardCostUsd}
      />

      {/* ── Measured 30d strip (Bug-B contract: the REAL measured block from
             the same getCostBreakdown read as /insights cost-breakdown,
             clearly separated from the planning numbers) + freshness stamp ── */}
      <MeasuredStrip baseline={baseline} />

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
          <PlannerV2SectionPanel id="giveaways" active={activeGroup}>
            <GiveawaysSection
              baseline={baseline}
              levers={levers}
              projection={projection}
              setLevers={setLevers}
            />
          </PlannerV2SectionPanel>
          <PlannerV2SectionPanel id="shards" active={activeGroup}>
            <ShardsSection
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
          <PlannerV2SectionPanel id="cashflow" active={activeGroup}>
            <CashflowSection
              baseline={baseline}
              levers={levers}
              projection={projection}
              setLevers={setLevers}
            />
          </PlannerV2SectionPanel>
          <PlannerV2SectionPanel id="matrix" active={activeGroup}>
            <CreditMatrixSection
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
              {scenario.active && (
                <span className="text-amber-600 dark:text-amber-400">
                  {" "}
                  · at 1× wager — the {scenario.multLabel} scenario applies to
                  the planning view above
                </span>
              )}
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

/**
 * The "Measured 30d" strip — `baseline.canonical` is the REAL measured
 * block from the same `getCostBreakdown` read the /insights cost-breakdown
 * page renders, shown SEPARATELY from the what-if planning numbers above
 * it, with the `ledgerMaxCreatedAt` data-freshness stamp. House-POV:
 * GGR/NGR ≥ 0 emerald, negative rose; reward cost is house pays → rose.
 */
function MeasuredStrip({ baseline }: { baseline: EdgePlanV2Baseline }) {
  const c = baseline.canonical;
  const stamp = baseline.ledgerMaxCreatedAt;

  return (
    <div className="rounded-xl border bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Database className="size-3.5" aria-hidden />
          Measured 30d — same source as /insights cost-breakdown
        </p>
        <p className="text-[10px] text-muted-foreground">
          {stamp
            ? `Data through ${formatDateTime(stamp)}`
            : "Data freshness unavailable"}
        </p>
      </div>

      {c == null ? (
        <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          The measured 30d read was unavailable — the planning numbers above
          stay what-if only and cannot be reconciled this render.
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
          <MeasuredStat label="Wager" value={formatCompactUsd(c.wager)} />
          <MeasuredStat
            label="GGR"
            value={formatCurrency(c.ggr)}
            tone={c.ggr >= 0 ? TEXT_TONE.emerald : TEXT_TONE.rose}
          />
          <MeasuredStat
            label="NGR"
            value={formatCurrency(c.ngr)}
            tone={c.ngr >= 0 ? TEXT_TONE.emerald : TEXT_TONE.rose}
          />
          <MeasuredStat
            label="Reward cost"
            value={formatCurrency(c.rewardCost)}
            tone={TEXT_TONE.rose}
          />
          <MeasuredStat
            label="House edge"
            value={c.houseEdge != null ? formatPct(c.houseEdge) : "—"}
            tone={
              c.houseEdge == null
                ? undefined
                : c.houseEdge >= 0
                  ? TEXT_TONE.emerald
                  : TEXT_TONE.rose
            }
          />
          <MeasuredStat label="Bets" value={formatNumber(c.bets)} />
        </div>
      )}
      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        In plain words: GGR = bets minus what players won back; NGR = GGR
        minus what we give away. This wager drops borrow plays while the
        won-card values stay counted, so the negative GGR here is an
        accounting view, not cash — the cash headline is the owner strip at
        the top.
      </p>
    </div>
  );
}

function MeasuredStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={cn("truncate text-sm font-semibold tabular-nums", tone)}>
        {value}
      </p>
    </div>
  );
}

/**
 * Owner-anchored headline strip + the mandatory lifetime reconciliation
 * row. Every figure comes from `baseline.recon` — the EXACT cached helpers
 * the /insights hub renders (`getInsightsHubWager*` + `getCostBreakdown`),
 * each band carrying a LOUD window chip so scopes are never mixed silently.
 * The reward drag here is the OWNER model: on-site reward spend ÷ hub
 * wager — creator-attributed leaderboard prizes live in the footnote, not
 * the drag.
 *
 * The lifetime reconciliation row additionally carries the DASHBOARD-
 * matching "Total P&L — balance-sheet snapshot · incl. unclaimed rakeback"
 * (`baseline.ownerTotalPnl`, read-only `getRealizedPnlSnapshot`) next to
 * the hub's windowed Realized P&L — two different formulas, both labeled
 * with their own one-liner (no invented bridge math).
 */
function OwnerAnchorStrip({
  baseline,
  projection,
}: {
  baseline: EdgePlanV2Baseline;
  projection: EdgePlanV2Projection;
}) {
  const d30 = baseline.recon.d30;
  const lifetime = baseline.recon.lifetime;
  const totalPnl = baseline.ownerTotalPnl ?? null;
  const drag = computeOwnerDragSummary(baseline, projection);
  const pnlTone = d30.realizedPnl >= 0 ? TEXT_TONE.emerald : TEXT_TONE.rose;
  const lifePnlTone =
    lifetime.realizedPnl >= 0 ? TEXT_TONE.emerald : TEXT_TONE.rose;
  const totalPnlTone =
    totalPnl != null && totalPnl.pnl >= 0 ? TEXT_TONE.emerald : TEXT_TONE.rose;
  const plannedDragMoved =
    drag.plannedDragPct != null &&
    drag.measuredDragPct != null &&
    Math.abs(drag.plannedDragPct - drag.measuredDragPct) > 0.00005;

  return (
    <div className="rounded-xl border bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Landmark className="size-3.5" aria-hidden />
          Owner-trusted headline — same helpers as the /insights hub
        </p>
        <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground">
          {d30.label}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Wager · real customers
          </p>
          <p className="truncate text-lg font-bold tabular-nums">
            {formatCurrency(d30.wager)}
          </p>
          <p className="text-[10px] leading-snug text-muted-foreground">
            In plain words: how much customers bet (real cash after borrow,
            upgrader included).
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Realized P&amp;L
          </p>
          <p className={cn("truncate text-lg font-bold tabular-nums", pnlTone)}>
            {d30.realizedPnl >= 0 ? "+" : "−"}
            {formatCurrency(Math.abs(d30.realizedPnl))}
          </p>
          <p className="text-[10px] leading-snug text-muted-foreground">
            In plain words: what the house actually banked this window.
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            On-site reward spend
          </p>
          <p className={cn("truncate text-lg font-bold tabular-nums", TEXT_TONE.rose)}>
            {formatCurrency(d30.onSiteRewardCost)}
            {d30.onSiteDragPct != null && (
              <span className="ml-1.5 text-xs font-semibold">
                = {formatPct(d30.onSiteDragPct)} of wager
              </span>
            )}
          </p>
          <p className="text-[10px] leading-snug text-muted-foreground">
            In plain words: how much of the edge the rewards eat
            {plannedDragMoved && drag.plannedDragPct != null && (
              <>
                {" "}
                · planner rows (incl. pack/signup item costs):{" "}
                {formatPct(drag.plannedDragPct)}
              </>
            )}
            .
          </p>
        </div>
      </div>

      {/* Creator-costs footnote — leaderboard prizes are NOT in the drag. */}
      <p className="mt-2 border-t pt-2 text-[10px] leading-snug text-muted-foreground">
        Creator costs not in this drag: affiliate leaderboard prizes{" "}
        <span className="font-medium text-foreground tabular-nums">
          {formatCurrency(d30.creatorLeaderboardCost)}
        </span>{" "}
        (attributed to Creators per the house model
        {d30.dragWithCreatorPct != null && (
          <> — drag incl. creator would read {formatPct(d30.dragWithCreatorPct)}</>
        )}
        ).
      </p>

      {/* Mandatory lifetime reconciliation row — equals the /insights hub,
          PLUS the dashboard-matching owner "Total P&L" next to it. The two
          P&L figures are DIFFERENT formulas (window + population + the
          unclaimed-rakeback term) — both are shown with their formula
          one-liners; no invented bridge math. */}
      <div className="mt-2 space-y-1.5 rounded-lg border bg-background/60 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground">
            {lifetime.label}
          </span>
          <span className="text-xs tabular-nums">
            Wager{" "}
            <span className="font-semibold">{formatCurrency(lifetime.wager)}</span>
          </span>
          <span className="text-xs tabular-nums">
            Realized P&amp;L{" "}
            <span className={cn("font-semibold", lifePnlTone)}>
              {lifetime.realizedPnl >= 0 ? "+" : "−"}
              {formatCurrency(Math.abs(lifetime.realizedPnl))}
            </span>{" "}
            <span className="text-[10px] text-muted-foreground">
              (/insights hub label — windowed: deposits − withdrawals −
              Δholdings inside the {lifetime.label} window, creators
              excluded)
            </span>
          </span>
          <span className="text-[10px] text-muted-foreground">
            — identical to the /insights hub by construction (same cached
            helpers).
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-1.5">
          <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground">
            Lifetime
          </span>
          <span className="text-xs tabular-nums">
            Total P&amp;L — balance-sheet snapshot · incl. unclaimed rakeback{" "}
            {totalPnl != null ? (
              <span className={cn("font-semibold", totalPnlTone)}>
                {totalPnl.pnl >= 0 ? "+" : "−"}
                {formatCurrency(Math.abs(totalPnl.pnl))}
              </span>
            ) : (
              <span className="font-semibold text-amber-600 dark:text-amber-400">
                unavailable this render (not cached — reload to retry)
              </span>
            )}{" "}
            <span className="text-[10px] text-muted-foreground">
              (dashboard tile — all-time: deposits − withdrawals − player
              holdings − unclaimed rakeback, creators included)
            </span>
          </span>
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          Why they differ: the two P&amp;L figures are different formulas —
          Total P&amp;L is the all-time balance sheet incl. the
          unclaimed-rakeback liability (creators count as customers), the
          hub Realized P&amp;L covers only the {lifetime.label} window with
          creators excluded. The gap is real, not a bug; it is not cleanly
          decomposable from these two helpers alone, so both are shown with
          their own formula.
        </p>
      </div>
    </div>
  );
}
