"use client";

import * as React from "react";
import {
  TrendingDown,
  PiggyBank,
  ShieldAlert,
  HandCoins,
  Scale,
  Gauge,
  Layers,
  LineChart as LineChartIcon,
  BarChart3,
  GitCompare,
  Lightbulb,
  Info,
  FlaskConical,
  Coins,
  ChevronDown,
  Sparkles,
} from "lucide-react";

import {
  KpiTile,
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../edge-calc/math";

import {
  recommend,
  simulateSet,
  type AccentColor,
  type BaseAssumptions,
  type BaseScenarioConfig,
  type ForecastBaseline,
  type ForecastConfig,
  type Recommendation,
  type SimulationResult,
} from "../_forecast-engine";
import { ForecastControls } from "./forecast-controls";
import {
  CostOverTimeChart,
  CumulativeCostChart,
  SavingsByScenarioChart,
  AbuseLeakageChart,
  SegmentContributionChart,
  SensitivityChart,
  type SensitivityPoint,
} from "./forecast-charts";
import { ForecastComparisonTable } from "./forecast-comparison-table";
import {
  encodeForecastState,
  decodeForecastState,
  type AnyAssumptions,
} from "./forecast-state";
import { formatLeverValue } from "./forecast-format";

/**
 * Forecast simulator — the live, REWARD-AGNOSTIC client island.
 *
 * Mirrors `edge-calc/scenario-builder.tsx`: the server fetches the real
 * baseline once and a per-reward client wrapper hands this island the reward's
 * `ForecastConfig` (imported as a module, NOT a server→client prop — that's why
 * the wrapper is `"use client"`). This island holds the levers in `useState`
 * and recomputes derived outputs in `useMemo` via the reward's PURE engine
 * (`config.simulate`, run through the shared `simulateSet` harness). No formulas
 * live here — every number comes from the reward's `_forecast/engine.ts`.
 *
 * The lever state is serializable: `encodeForecastState` round-trips it to the
 * URL `?fc=` param so a shared link reopens the same scenario.
 *
 * House-POV throughout: user-favorable numbers (savings against the house, NGR
 * accretion) render emerald; house outflows (cost, abuse leakage) render
 * rose / amber. Flip-test passed per CLAUDE.md.
 */

const HORIZON_DEFAULT = 30;

export type ForecastSimulatorProps<A extends BaseAssumptions, S extends BaseScenarioConfig> = {
  /** The reward's full forecast config (with the pure `simulate` fn). */
  config: ForecastConfig<A, S>;
  /** Real production anchor. Always present — the server renders an empty state otherwise. */
  realBaseline: ForecastBaseline;
  /** Human label for the active period, e.g. "Last 30 days". */
  period: string;
  /** Optional reward-specific baseline sub-label, e.g. "$100/24h". */
  baselineNote?: string;
};

export function ForecastSimulator<A extends BaseAssumptions, S extends BaseScenarioConfig>({
  config,
  realBaseline,
  period,
  baselineNote,
}: ForecastSimulatorProps<A, S>) {
  const {
    simulate,
    defaults,
    scenarios: staticFullSet,
    whatifSet: staticWhatifSet,
    baselineScenarioId: staticBaselineScenarioId,
    buildScenarios,
    segments,
    levers,
    segmentMixLever,
    colors,
    capLabel,
    capComplexity,
    pacingFrontload,
  } = config;

  // LIVE scenario set: when the reward derives its scenarios from the REAL
  // baseline policy (rakeback / affiliate fetch the configured rates at request
  // time and thread them onto `realBaseline`), use that — so the baseline
  // scenario + what-ifs reflect the actual production policy, not a placeholder.
  // Falls back to the reward's static library when no builder is provided or it
  // returns null (e.g. the real config could not be threaded).
  const built = React.useMemo(
    () => (buildScenarios ? buildScenarios(realBaseline) : null),
    [buildScenarios, realBaseline],
  );
  const fullSet = built?.scenarios ?? staticFullSet;
  const whatifSet = built?.whatifSet ?? (built ? undefined : staticWhatifSet);
  const baselineScenarioId = built?.baselineScenarioId ?? staticBaselineScenarioId;

  // Numeric lever keys to validate in the URL codec (reward-specific levers).
  const leverKeys = React.useMemo(() => levers.map((l) => l.key), [levers]);

  // Accent tokens (house-POV) with sane defaults.
  const costAccent: AccentColor = colors?.cost ?? "rose";
  const leakAccent: AccentColor = colors?.leakage ?? "amber";
  const retainAccent: AccentColor = colors?.retained ?? "emerald";

  // Build initial assumptions from the reward's defaults (seeded by the real
  // baseline), then overlay any shared-URL state.
  const seedAssumptions = React.useMemo(
    () => defaults(realBaseline) as A,
    [defaults, realBaseline],
  );

  const initial = React.useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return decodeForecastState(params.get("fc"), leverKeys);
  }, [leverKeys]);

  const [scenarioId, setScenarioId] = React.useState<string>(
    initial?.scenarioId ?? baselineScenarioId,
  );
  const [showWhatifSet, setShowWhatifSet] = React.useState<boolean>(
    initial?.showWhatifSet ?? false,
  );
  const [assumptions, setAssumptions] = React.useState<A>(
    (initial?.assumptions as A | undefined) ?? seedAssumptions,
  );

  const baseline = realBaseline;

  // Scenario set the comparison table + charts iterate over.
  const scenarioSet = showWhatifSet && whatifSet ? whatifSet : fullSet;

  // Keep the active scenario valid for the current set; fall back to baseline.
  React.useEffect(() => {
    if (!scenarioSet.some((s) => s.id === scenarioId)) {
      setScenarioId(baselineScenarioId);
    }
  }, [scenarioSet, scenarioId, baselineScenarioId]);

  // ── THE ENGINE CALL — recompute the whole set on any lever change ──
  // ANCHOR the set on the REAL total cost so the baseline scenario reads the
  // production number in every view, the others as coherent fractions of it.
  const anchorCostUsd = baseline.totalCost;
  const windowDays = Number(assumptions.windowDays) || HORIZON_DEFAULT;
  const results = React.useMemo<SimulationResult[]>(
    () =>
      simulateSet(scenarioSet, assumptions, { days: windowDays }, simulate, {
        baselineId: baselineScenarioId,
        anchorBaselineCostUsd: anchorCostUsd,
        pacingFrontload,
      }),
    [scenarioSet, assumptions, windowDays, simulate, baselineScenarioId, anchorCostUsd, pacingFrontload],
  );

  const recommendations = React.useMemo<Recommendation[]>(
    () => recommend(results),
    [results],
  );

  const activeResult = React.useMemo(
    () => results.find((r) => r.scenarioId === scenarioId) ?? results[0],
    [results, scenarioId],
  );
  const baselineResult = React.useMemo(
    () => results.find((r) => r.scenarioId === baselineScenarioId) ?? results[0],
    [results, baselineScenarioId],
  );

  // Fixed anchor scale (real total ÷ raw slider-derived baseline cost), so the
  // sensitivity sweep plots on the SAME anchored scale as the rest of the page.
  const anchorScale = React.useMemo(() => {
    const refScenario = scenarioSet.find((s) => s.id === baselineScenarioId) ?? scenarioSet[0];
    if (!refScenario) return 1;
    const rawBaseline = simulateSet([refScenario], assumptions, { days: windowDays }, simulate, {
      baselineId: baselineScenarioId,
      pacingFrontload,
    })[0];
    const rawCost = rawBaseline?.bonusCost ?? 0;
    return anchorCostUsd > 0 && rawCost > 0 ? anchorCostUsd / rawCost : 1;
  }, [scenarioSet, assumptions, windowDays, simulate, baselineScenarioId, anchorCostUsd, pacingFrontload]);

  // Sensitivity sweep: vary the avg-reward lever ±60% around its current value,
  // recompute the ACTIVE scenario's cost at each step. Pure engine calls.
  const sensitivity = React.useMemo<SensitivityPoint[]>(() => {
    const activeScenario = scenarioSet.find((s) => s.id === scenarioId);
    if (!activeScenario) return [];
    const base = Number(assumptions.avgBonusUsd) || 0;
    const steps = 13;
    const out: SensitivityPoint[] = [];
    for (let i = 0; i < steps; i++) {
      const factor = 0.4 + (1.2 * i) / (steps - 1); // 0.4×..1.6×
      const x = Math.max(0, base * factor);
      const res = simulateSet(
        [activeScenario],
        { ...assumptions, avgBonusUsd: x },
        { days: windowDays },
        simulate,
        { baselineId: activeScenario.id, pacingFrontload },
      )[0];
      out.push({ x, label: `$${x.toFixed(0)}`, bonusCost: res.bonusCost * anchorScale });
    }
    return out;
  }, [scenarioSet, scenarioId, assumptions, windowDays, simulate, anchorScale, pacingFrontload]);

  // Sync the serialized state onto the URL (replaceState, no navigation).
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const encoded = encodeForecastState({
      scenarioId,
      showWhatifSet,
      assumptions: assumptions as AnyAssumptions,
    });
    const params = new URLSearchParams(window.location.search);
    params.set("fc", encoded);
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", next);
  }, [scenarioId, showWhatifSet, assumptions]);

  const onReset = React.useCallback(() => {
    setAssumptions(defaults(realBaseline) as A);
    setScenarioId(baselineScenarioId);
  }, [defaults, realBaseline, baselineScenarioId]);

  if (!activeResult || !baselineResult) {
    return (
      <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
        No scenarios to simulate.
      </div>
    );
  }

  const comparisonRows = scenarioSet.map((scenario) => ({
    scenario,
    result: results.find((r) => r.scenarioId === scenario.id) ?? activeResult,
  }));
  const chartRows = scenarioSet.map((s) => ({
    id: s.id,
    label: s.label,
    result: results.find((r) => r.scenarioId === s.id) ?? activeResult,
  }));

  const netSavings = activeResult.netSavingsVsBaseline;
  const isBaselineActive = scenarioId === baselineScenarioId;

  return (
    <div className="space-y-6">
      {/* ── Real-baseline note ───────────────────────────────────── */}
      <FadeIn>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          <FlaskConical className="size-3.5 shrink-0" />
          <span>
            <strong>Real baseline.</strong> Cost, claimants, avg reward, claim probability and ROI
            are the measured production figures ({period}). The behavioural levers below remain
            tunable assumptions — outputs stay <strong>directional</strong>.
          </span>
        </div>
      </FadeIn>

      {/* ── 1. KPI ROW ───────────────────────────────────────────── */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label="Baseline cost"
            value={formatCurrency(baselineResult.bonusCost)}
            sub={baselineNote ? `${windowDays}d · ${baselineNote}` : `${windowDays}d horizon`}
            icon={Coins}
            accent={costAccent}
          />
          <KpiTile
            label="Projected cost"
            value={formatCurrency(activeResult.bonusCost)}
            sub="±15% band"
            icon={TrendingDown}
            accent={costAccent}
          />
          <KpiTile
            label="Net savings"
            value={isBaselineActive ? "—" : formatSignedUsd(netSavings)}
            sub={isBaselineActive ? "baseline = reference" : "after retention loss"}
            icon={PiggyBank}
            // Net savings POSITIVE = house keeps more money = emerald.
            accent={isBaselineActive ? "blue" : netSavings >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="Abuse leakage"
            value={formatCurrency(activeResult.abuseLeakage)}
            sub="reward lost to abuse"
            icon={ShieldAlert}
            accent={leakAccent}
          />
          <KpiTile
            label="Retained revenue"
            value={formatCurrency(activeResult.retainedRevenue)}
            sub="downstream from legit reward"
            icon={HandCoins}
            accent={retainAccent}
          />
          <KpiTile
            label="NGR impact"
            value={formatSignedUsd(activeResult.ngrImpact)}
            sub={activeResult.ngrImpact >= 0 ? "NGR-accretive" : "NGR-dilutive"}
            icon={Scale}
            accent={activeResult.ngrImpact >= 0 ? "emerald" : "rose"}
          />
        </div>
      </FadeIn>

      {/* ── controls + recommendations + charts layout ───────────── */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
        {/* Left rail — controls */}
        <div className="space-y-6">
          <FadeIn>
            <ForecastControls
              scenarios={scenarioSet}
              activeScenarioId={scenarioId}
              onScenarioChange={setScenarioId}
              assumptions={assumptions as AnyAssumptions}
              onAssumptionsChange={(next) => setAssumptions(next as A)}
              levers={levers}
              segmentMixLever={segmentMixLever}
              segments={segments}
              whatif={
                whatifSet
                  ? {
                      label: "Compare what-if set",
                      hint: "Focus on the reward's what-if comparison set, or show the full scenario library.",
                      checked: showWhatifSet,
                      onCheckedChange: setShowWhatifSet,
                    }
                  : undefined
              }
              onReset={onReset}
            />
          </FadeIn>
        </div>

        {/* Right — recommendations + charts + table */}
        <div className="space-y-6">
          {/* ── RECOMMENDATION CARDS ─────────────────────────────── */}
          <FadeIn>
            <div className="space-y-3">
              <SectionHeading icon={Lightbulb} title="Recommendations" />
              <div className="grid gap-3 sm:grid-cols-3">
                {recommendations.map((rec) => (
                  <RecommendationCard
                    key={rec.badge}
                    rec={rec}
                    scenarioLabel={
                      scenarioSet.find((s) => s.id === rec.scenarioId)?.label ?? rec.scenarioId
                    }
                    active={rec.scenarioId === scenarioId}
                    onSelect={() => setScenarioId(rec.scenarioId)}
                  />
                ))}
                {recommendations.length === 0 && (
                  <div className="col-span-full rounded-xl border border-dashed bg-muted/20 p-4 text-center text-xs text-muted-foreground">
                    Adjust the levers to surface a recommendation.
                  </div>
                )}
              </div>
            </div>
          </FadeIn>

          {/* ── FORECAST CHARTS ──────────────────────────────────── */}
          <FadeIn>
            <div className="space-y-4">
              <SectionHeading icon={LineChartIcon} title="Forecast charts" />
              <div className="grid gap-4 xl:grid-cols-2">
                <ChartCard
                  title="Cost over time"
                  subtitle={`Active scenario · ${windowDays}d`}
                  icon={TrendingDown}
                >
                  <CostOverTimeChart result={activeResult} />
                </ChartCard>
                <ChartCard
                  title="Cumulative cost"
                  subtitle="Running total over the horizon"
                  icon={LineChartIcon}
                >
                  <CumulativeCostChart result={activeResult} />
                </ChartCard>
                <ChartCard
                  title="Net savings vs baseline"
                  subtitle="Per scenario, after retention loss"
                  icon={PiggyBank}
                >
                  <SavingsByScenarioChart rows={chartRows} baselineId={baselineScenarioId} />
                </ChartCard>
                <ChartCard
                  title="Abuse leakage per model"
                  subtitle="Lower = more abuse captured"
                  icon={ShieldAlert}
                >
                  <AbuseLeakageChart rows={chartRows} baselineId={baselineScenarioId} />
                </ChartCard>
                <ChartCard
                  title="Segment cost contribution"
                  subtitle="Cost stacked by segment"
                  icon={Layers}
                >
                  <SegmentContributionChart rows={chartRows} segments={segments} />
                </ChartCard>
                <ChartCard
                  title="Sensitivity — avg reward → cost"
                  subtitle="Active scenario cost as avg reward sweeps ±60%"
                  icon={BarChart3}
                >
                  <SensitivityChart points={sensitivity} xUnit="avg reward" />
                </ChartCard>
              </div>
            </div>
          </FadeIn>
        </div>
      </div>

      {/* ── COMPARISON TABLE (full width) ────────────────────────── */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={GitCompare}
            title="Scenario comparison"
            action={
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {showWhatifSet && whatifSet ? "What-if set" : "Full library"} · {scenarioSet.length} models
              </Badge>
            }
          />
          <div className="relative overflow-hidden rounded-2xl border bg-card p-3 sm:p-4">
            <ForecastComparisonTable
              rows={comparisonRows}
              baselineId={baselineScenarioId}
              recommendations={recommendations}
              activeScenarioId={scenarioId}
              onSelectScenario={setScenarioId}
              capLabel={capLabel}
              capComplexity={capComplexity}
            />
          </div>
        </div>
      </FadeIn>

      {/* ── SEGMENT ANALYSIS ─────────────────────────────────────── */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Layers}
            title="Segment analysis"
            action={
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {scenarioSet.find((s) => s.id === scenarioId)?.label ?? scenarioId}
              </Badge>
            }
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {activeResult.perSegment.map((seg) => {
              const meta = segments.find((s) => s.id === seg.segment);
              return (
                <StatPanel
                  key={seg.segment}
                  title={seg.label}
                  icon={meta?.id === "high_risk_abuse" ? ShieldAlert : Sparkles}
                  accent={meta?.accent ?? "blue"}
                >
                  <p className="text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(seg.bonusCost)}
                  </p>
                  <p className="text-xs text-muted-foreground">reward cost (horizon)</p>
                  <div className="mt-3 space-y-1">
                    <PanelRow label="Claimants" value={formatNumber(Math.round(seg.claimants))} />
                    <PanelRow label="Effective cap" value={formatCurrency(seg.effectiveCapUsd)} />
                    <PanelRow
                      label="Abuse leakage"
                      value={formatCurrency(seg.abuseLeakage)}
                      valueClassName="text-amber-600 dark:text-amber-400"
                    />
                    <PanelRow
                      label="Retained revenue"
                      value={formatCurrency(seg.retainedRevenue)}
                      valueClassName="text-emerald-600 dark:text-emerald-400"
                    />
                    <PanelRow
                      label="NGR impact"
                      value={formatSignedUsd(seg.ngrImpact)}
                      valueClassName={
                        seg.ngrImpact >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400"
                      }
                    />
                  </div>
                </StatPanel>
              );
            })}
          </div>
        </div>
      </FadeIn>

      {/* ── ASSUMPTIONS + LIMITATIONS ────────────────────────────── */}
      <FadeIn>
        <AssumptionsPanel baseline={baseline} levers={levers} assumptions={assumptions} />
      </FadeIn>
    </div>
  );
}

// ─── Recommendation card ─────────────────────────────────────────────

const REC_META: Record<
  Recommendation["badge"],
  { label: string; chip: string; icon: React.ElementType }
> = {
  "highest-savings": {
    label: "Highest savings",
    chip: "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    icon: PiggyBank,
  },
  "lowest-friction": {
    label: "Lowest friction",
    chip: "border-blue-500/30 bg-blue-500/15 text-blue-600 dark:text-blue-400",
    icon: Gauge,
  },
  "best-balance": {
    label: "Best balance",
    chip: "border-purple-500/30 bg-purple-500/15 text-purple-600 dark:text-purple-400",
    icon: Scale,
  },
};

function RecommendationCard({
  rec,
  scenarioLabel,
  active,
  onSelect,
}: {
  rec: Recommendation;
  scenarioLabel: string;
  active: boolean;
  onSelect: () => void;
}) {
  const meta = REC_META[rec.badge];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card p-3.5 text-left transition-colors",
        active ? "border-primary/40 ring-1 ring-primary/30" : "hover:border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className={cn("font-medium", meta.chip)}>
          <Icon className="size-3" />
          {meta.label}
        </Badge>
      </div>
      <p className="mt-2 truncate text-sm font-semibold">{scenarioLabel}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{rec.detail}</p>
    </button>
  );
}

// ─── Chart card wrapper ──────────────────────────────────────────────

function ChartCard({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

// ─── Assumptions + limitations panel (reward-agnostic) ───────────────

function AssumptionsPanel<A extends BaseAssumptions>({
  baseline,
  levers,
  assumptions,
}: {
  baseline: ForecastBaseline;
  levers: ForecastConfig<A>["levers"];
  assumptions: A;
}) {
  const [open, setOpen] = React.useState(false);

  // Anchors — ALWAYS real production figures (the page has no demo path).
  const realRows: Array<{ label: string; value: string }> = [
    { label: "Baseline total cost", value: formatCurrency(baseline.totalCost) },
    { label: "Unique claimants", value: formatNumber(baseline.uniqueClaimants) },
    {
      label: "Claim probability (claimants ÷ qualifiers)",
      value: baseline.claimProbability != null ? formatPct(baseline.claimProbability) : "—",
    },
    { label: "Avg reward", value: formatCurrency(baseline.avgBonusUsd) },
    { label: "Empirical cap (max reward)", value: formatCurrency(baseline.empiricalCapUsd) },
    {
      label: "Cap-hit rate",
      value: baseline.capHitRate != null ? formatPct(baseline.capHitRate) : "—",
    },
    {
      label: "Blended ROI (forward)",
      value: baseline.blendedRoi != null ? `${baseline.blendedRoi.toFixed(2)}×` : "—",
    },
  ];

  // Behavioural assumptions — derived generically from the active levers, so a
  // reward with any lever set renders its current values without bespoke copy.
  const assumptionRows: Array<{ label: string; value: string }> = levers.map((lever) => ({
    label: lever.label,
    value: formatLeverValue(
      Number((assumptions as Record<string, number>)[lever.key]) || 0,
      lever.format,
      lever.decimals,
    ),
  }));

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-2xl border border-dashed bg-muted/20">
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Info className="size-4 text-muted-foreground" />
                Assumptions &amp; limitations
              </span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
              />
            </button>
          }
        />
        <CollapsibleContent>
          <div className="space-y-5 border-t border-dashed px-4 py-4 text-xs leading-relaxed text-muted-foreground">
            {/* Disclaimer block */}
            <div className="rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300">
              <p className="font-semibold">What is real vs assumed vs directional</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                <li>
                  <strong>Real anchors</strong> (always): total cost, claimants, claim probability,
                  avg reward, empirical cap, cap-hit rate and blended ROI — fetched from the
                  reward&apos;s canonical queries. The claimant volume is scaled from the selected
                  period to the forecast horizon.
                </li>
                <li>
                  <strong>Assumptions</strong> (sliders): the behavioural levers. Claim probability
                  and avg reward default to their real measured values but stay tunable for what-if.
                  These are inputs, not predictions.
                </li>
                <li>
                  <strong>Directional only.</strong> Outputs show the <em>shape</em> of each policy&apos;s
                  trade-off, not a guaranteed dollar figure. The ±15% band is illustrative.
                </li>
                <li>
                  <strong>Not a fraud predictor.</strong> Abuse leakage is computed from the
                  abuse-share <em>assumption</em> — a what-if, not a detection signal.
                </li>
              </ul>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <ConstColumn
                title="Baseline anchor (REAL)"
                rows={realRows.map((r) => ({ ...r, tag: "real" as const }))}
              />
              <ConstColumn
                title="Behavioural assumptions"
                rows={assumptionRows.map((r) => ({ ...r, tag: "assumption" as const }))}
              />
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ConstColumn({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: string; tag: "real" | "assumption" }>;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground">{title}</p>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <TagDot tag={r.tag} />
              <span className="truncate">{r.label}</span>
            </span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TagDot({ tag }: { tag: "real" | "assumption" }) {
  const cls = tag === "real" ? "bg-emerald-500" : "bg-blue-500";
  return <span className={cn("size-1.5 shrink-0 rounded-full", cls)} aria-hidden />;
}
