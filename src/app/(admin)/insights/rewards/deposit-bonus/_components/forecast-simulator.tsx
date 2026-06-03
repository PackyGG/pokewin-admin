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
import { formatPct, formatSignedUsd } from "../../../edge-calc/math";

import {
  simulateSet,
  recommend,
  SCENARIO_LIBRARY,
  SPLIT_CAP_WHATIF_SET,
  BASELINE_SCENARIO_ID,
  SEGMENTS,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_ABUSE_SHARE,
  DEFAULT_ABUSE_CAPTURE_ELASTICITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_AVG_BONUS_USD,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_SEGMENT_MIX,
  BASELINE_CAP_USD,
  BASELINE_WINDOW_HOURS,
  SPLIT_CAP_BURST_DAMPING,
  OVERGENEROUS_CAP_THRESHOLD_USD,
  CONFIDENCE_BAND_SPREAD,
  type Assumptions,
  type ForecastBaseline,
  type Recommendation,
  type SimulationResult,
} from "../_forecast";
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
import { encodeForecastState, decodeForecastState } from "./forecast-state";

/**
 * Forecast simulator — the live client island.
 *
 * Mirrors `edge-calc/scenario-builder.tsx`: server fetches the real baseline
 * once, this component holds the levers in `useState` and recomputes derived
 * outputs in `useMemo` via the PURE engine (`simulateSet` / `recommend`). No
 * formulas live here — every number comes from `_forecast/engine.ts`.
 *
 * The full scenario config (active scenario, set, assumptions, baseline mode)
 * is serializable: `encodeForecastState` round-trips it to a compact object so
 * a future "save / share" can drop it on the URL. We hydrate the initial state
 * from the URL `?fc=` param if present, so a shared link reopens the same
 * scenario.
 *
 * House-POV throughout: user-favorable numbers (savings against the house,
 * NGR accretion) render emerald; house outflows (cost, abuse leakage) render
 * rose / amber. Flip-test passed per CLAUDE.md.
 */

function defaultAssumptions(baseline: ForecastBaseline | null): Assumptions {
  return {
    eligibleUsers: 4000,
    segmentMix: { ...DEFAULT_SEGMENT_MIX },
    depositsPerUserPerWindow: DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
    claimProbability: DEFAULT_CLAIM_PROBABILITY,
    avgBonusUsd: baseline?.avgBonusUsd ?? DEFAULT_AVG_BONUS_USD,
    breakageRate: DEFAULT_BREAKAGE_RATE,
    abuseShare: DEFAULT_ABUSE_SHARE,
    abuseCaptureElasticity: DEFAULT_ABUSE_CAPTURE_ELASTICITY,
    retentionUplift: DEFAULT_RETENTION_UPLIFT,
    cannibalizationRate: DEFAULT_CANNIBALIZATION_RATE,
    legitConversionSensitivity: DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
    windowDays: DEFAULT_WINDOW_DAYS,
  };
}

export function ForecastSimulator({
  realBaseline,
  demoBaseline,
  isDemo,
  period,
}: {
  /** Real production anchor (null if the server fetch failed / empty period). */
  realBaseline: ForecastBaseline | null;
  /** Always-present DEMO anchor. */
  demoBaseline: ForecastBaseline;
  /** True when the server could not get a real baseline (forces DEMO badge). */
  isDemo: boolean;
  period: string;
}) {
  const realAvailable = realBaseline != null;

  // Initial state — hydrate from the URL if a shared scenario is present.
  const initial = React.useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return decodeForecastState(params.get("fc"));
  }, []);

  const [scenarioId, setScenarioId] = React.useState<string>(
    initial?.scenarioId ?? BASELINE_SCENARIO_ID,
  );
  const [showSplitCapSet, setShowSplitCapSet] = React.useState<boolean>(
    initial?.showSplitCapSet ?? false,
  );
  const [useRealBaseline, setUseRealBaseline] = React.useState<boolean>(
    initial?.useRealBaseline ?? realAvailable,
  );
  const [assumptions, setAssumptions] = React.useState<Assumptions>(
    initial?.assumptions ?? defaultAssumptions(realAvailable ? realBaseline : null),
  );

  // The active baseline anchor: real (if toggled on & available) else DEMO.
  const baseline: ForecastBaseline =
    useRealBaseline && realAvailable ? (realBaseline as ForecastBaseline) : demoBaseline;
  const onDemoData = !(useRealBaseline && realAvailable);

  // Scenario set the comparison table + charts iterate over.
  const scenarioSet = showSplitCapSet ? SPLIT_CAP_WHATIF_SET : SCENARIO_LIBRARY;

  // Keep the active scenario valid for the current set; fall back to baseline.
  React.useEffect(() => {
    if (!scenarioSet.some((s) => s.id === scenarioId)) {
      setScenarioId(BASELINE_SCENARIO_ID);
    }
  }, [scenarioSet, scenarioId]);

  // ── THE ENGINE CALL — recompute the whole set on any lever change ──
  const results = React.useMemo<SimulationResult[]>(
    () =>
      simulateSet(
        scenarioSet,
        assumptions,
        { days: assumptions.windowDays },
        BASELINE_SCENARIO_ID,
      ),
    [scenarioSet, assumptions],
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
    () => results.find((r) => r.scenarioId === BASELINE_SCENARIO_ID) ?? results[0],
    [results],
  );

  // Sensitivity sweep: vary the avg-bonus lever ±60% around its current value,
  // recompute the ACTIVE scenario's cost at each step. Pure engine calls — the
  // chart just plots the response curve.
  const sensitivity = React.useMemo<SensitivityPoint[]>(() => {
    const activeScenario = scenarioSet.find((s) => s.id === scenarioId);
    if (!activeScenario) return [];
    const base = assumptions.avgBonusUsd;
    const steps = 13;
    const out: SensitivityPoint[] = [];
    for (let i = 0; i < steps; i++) {
      const factor = 0.4 + (1.2 * i) / (steps - 1); // 0.4×..1.6×
      const x = Math.max(0, base * factor);
      const res = simulateSet(
        [activeScenario],
        { ...assumptions, avgBonusUsd: x },
        { days: assumptions.windowDays },
        activeScenario.id,
      )[0];
      out.push({ x, label: `$${x.toFixed(0)}`, bonusCost: res.bonusCost });
    }
    return out;
  }, [scenarioSet, scenarioId, assumptions]);

  // Sync the serialized state onto the URL (replaceState, no navigation) so the
  // current scenario is shareable without re-rendering the server tree.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const encoded = encodeForecastState({
      scenarioId,
      showSplitCapSet,
      useRealBaseline,
      assumptions,
    });
    const params = new URLSearchParams(window.location.search);
    params.set("fc", encoded);
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", next);
  }, [scenarioId, showSplitCapSet, useRealBaseline, assumptions]);

  const onReset = React.useCallback(() => {
    setAssumptions(defaultAssumptions(realAvailable ? realBaseline : null));
    setScenarioId(BASELINE_SCENARIO_ID);
  }, [realAvailable, realBaseline]);

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
  const isBaselineActive = scenarioId === BASELINE_SCENARIO_ID;

  return (
    <div className="space-y-6">
      {/* ── DEMO banner ──────────────────────────────────────────── */}
      <FadeIn>
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-dashed px-3 py-2 text-xs",
            onDemoData
              ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300"
              : "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
          )}
        >
          <FlaskConical className="size-3.5 shrink-0" />
          {onDemoData ? (
            <span>
              <strong>Forecasting model.</strong> Behavioural inputs are tunable{" "}
              <strong>assumptions</strong>, not measured values
              {isDemo
                ? " — and the baseline anchor is DEMO data (no real deposit-bonus rows for this period)."
                : ". Toggle “Use real baseline” to anchor cost / claimants / cap / ROI on production numbers."}{" "}
              Conclusions are <strong>directional</strong>.
            </span>
          ) : (
            <span>
              <strong>Real baseline active</strong> (cost / claimants / cap / ROI from production,{" "}
              {period}). Behavioural levers below remain tunable assumptions — outputs stay
              directional.
            </span>
          )}
        </div>
      </FadeIn>

      {/* ── 1. KPI ROW ───────────────────────────────────────────── */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label="Baseline cost"
            value={formatCurrency(baselineResult.bonusCost)}
            sub={`${assumptions.windowDays}d · $${BASELINE_CAP_USD}/${BASELINE_WINDOW_HOURS}h`}
            icon={Coins}
            accent="rose"
          />
          <KpiTile
            label="Projected cost"
            value={formatCurrency(activeResult.bonusCost)}
            sub={`±${(CONFIDENCE_BAND_SPREAD * 100).toFixed(0)}% band`}
            icon={TrendingDown}
            accent="rose"
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
            sub="bonus lost to abuse"
            icon={ShieldAlert}
            accent="amber"
          />
          <KpiTile
            label="Retained revenue"
            value={formatCurrency(activeResult.retainedRevenue)}
            sub="downstream from legit bonus"
            icon={HandCoins}
            accent="emerald"
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

      {/* ── 2 (controls) + 6 (recommendations) + charts layout ───── */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
        {/* Left rail — controls */}
        <div className="space-y-6">
          <FadeIn>
            <ForecastControls
              scenarios={scenarioSet}
              activeScenarioId={scenarioId}
              onScenarioChange={setScenarioId}
              assumptions={assumptions}
              onAssumptionsChange={setAssumptions}
              useRealBaseline={useRealBaseline}
              onUseRealBaselineChange={setUseRealBaseline}
              showSplitCapSet={showSplitCapSet}
              onShowSplitCapSetChange={setShowSplitCapSet}
              onReset={onReset}
              realBaselineAvailable={realAvailable}
            />
          </FadeIn>
        </div>

        {/* Right — recommendations + charts + table */}
        <div className="space-y-6">
          {/* ── 6. RECOMMENDATION CARDS ──────────────────────────── */}
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

          {/* ── 4. FORECAST CHARTS ───────────────────────────────── */}
          <FadeIn>
            <div className="space-y-4">
              <SectionHeading icon={LineChartIcon} title="Forecast charts" />
              <div className="grid gap-4 xl:grid-cols-2">
                <ChartCard
                  title="Cost over time"
                  subtitle={`Active scenario · ${assumptions.windowDays}d`}
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
                  <SavingsByScenarioChart rows={chartRows} baselineId={BASELINE_SCENARIO_ID} />
                </ChartCard>
                <ChartCard
                  title="Abuse leakage per model"
                  subtitle="Lower = more abuse captured"
                  icon={ShieldAlert}
                >
                  <AbuseLeakageChart rows={chartRows} baselineId={BASELINE_SCENARIO_ID} />
                </ChartCard>
                <ChartCard
                  title="Segment cost contribution"
                  subtitle="Bonus cost stacked by segment"
                  icon={Layers}
                >
                  <SegmentContributionChart rows={chartRows} />
                </ChartCard>
                <ChartCard
                  title="Sensitivity — avg bonus → cost"
                  subtitle="Active scenario cost as avg bonus sweeps ±60%"
                  icon={BarChart3}
                >
                  <SensitivityChart points={sensitivity} xUnit="avg bonus" />
                </ChartCard>
              </div>
            </div>
          </FadeIn>
        </div>
      </div>

      {/* ── 3. COMPARISON TABLE (full width) ─────────────────────── */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={GitCompare}
            title="Scenario comparison"
            action={
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {showSplitCapSet ? "Split-cap set" : "Full A–E library"} · {scenarioSet.length} models
              </Badge>
            }
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-3 sm:p-4">
            <ForecastComparisonTable
              rows={comparisonRows}
              baselineId={BASELINE_SCENARIO_ID}
              recommendations={recommendations}
              activeScenarioId={scenarioId}
              onSelectScenario={setScenarioId}
            />
          </div>
        </div>
      </FadeIn>

      {/* ── 5. SEGMENT ANALYSIS ──────────────────────────────────── */}
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
              const meta = SEGMENTS.find((s) => s.id === seg.segment);
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
                  <p className="text-xs text-muted-foreground">bonus cost (horizon)</p>
                  <div className="mt-3 space-y-1">
                    <PanelRow label="Claimants" value={formatNumber(Math.round(seg.claimants))} />
                    <PanelRow
                      label="Effective cap"
                      value={formatCurrency(seg.effectiveCapUsd)}
                    />
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

      {/* ── 7. ASSUMPTIONS + LIMITATIONS ─────────────────────────── */}
      <FadeIn>
        <AssumptionsPanel assumptions={assumptions} onDemoData={onDemoData} baseline={baseline} />
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
        "group surface-sheen relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/70 p-3.5 text-left transition-colors",
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
    <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4">
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

// ─── 7. Assumptions + limitations panel ──────────────────────────────

function AssumptionsPanel({
  assumptions,
  onDemoData,
  baseline,
}: {
  assumptions: Assumptions;
  onDemoData: boolean;
  baseline: ForecastBaseline;
}) {
  const [open, setOpen] = React.useState(false);

  const realRows: Array<{ label: string; value: string; status: "real" | "demo" }> = [
    {
      label: "Baseline total cost",
      value: formatCurrency(baseline.totalCost),
      status: onDemoData ? "demo" : "real",
    },
    {
      label: "Unique claimants",
      value: formatNumber(baseline.uniqueClaimants),
      status: onDemoData ? "demo" : "real",
    },
    {
      label: "Empirical cap (max bonus)",
      value: formatCurrency(baseline.empiricalCapUsd),
      status: onDemoData ? "demo" : "real",
    },
    {
      label: "Cap-hit rate",
      value: baseline.capHitRate != null ? formatPct(baseline.capHitRate) : "—",
      status: onDemoData ? "demo" : "real",
    },
    {
      label: "Blended ROI (14d forward)",
      value: baseline.blendedRoi != null ? `${baseline.blendedRoi.toFixed(2)}×` : "—",
      status: onDemoData ? "demo" : "real",
    },
  ];

  const assumptionRows: Array<{ label: string; value: string }> = [
    { label: "Claim probability", value: formatPct(assumptions.claimProbability) },
    { label: "Avg bonus (pre-cap)", value: formatCurrency(assumptions.avgBonusUsd) },
    { label: "Breakage rate", value: formatPct(assumptions.breakageRate) },
    { label: "Abuse share (at baseline cap)", value: formatPct(assumptions.abuseShare) },
    {
      label: "Abuse-capture elasticity",
      value: formatPct(assumptions.abuseCaptureElasticity),
    },
    { label: "Retention uplift", value: formatPct(assumptions.retentionUplift) },
    { label: "Cannibalization rate", value: formatPct(assumptions.cannibalizationRate) },
    {
      label: "Legit conversion sensitivity",
      value: formatPct(assumptions.legitConversionSensitivity),
    },
    {
      label: "Deposits / user / window",
      value: assumptions.depositsPerUserPerWindow.toFixed(1),
    },
  ];

  const constantRows: Array<{ label: string; value: string }> = [
    { label: "Split-cap burst damping", value: `${SPLIT_CAP_BURST_DAMPING}×` },
    { label: "Over-generous cap threshold", value: formatCurrency(OVERGENEROUS_CAP_THRESHOLD_USD) },
    { label: "Confidence band", value: `±${(CONFIDENCE_BAND_SPREAD * 100).toFixed(0)}%` },
    { label: "Baseline cap", value: `$${BASELINE_CAP_USD} / ${BASELINE_WINDOW_HOURS}h` },
  ];

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
                  <strong>Real</strong> (when “Use real baseline” is on): total cost, claimants,
                  empirical cap, cap-hit rate, blended ROI — fetched from{" "}
                  <code className="font-mono">getDepositBonusOverview</code> /{" "}
                  <code className="font-mono">…CapHitRate</code> /{" "}
                  <code className="font-mono">…ROI</code>.
                </li>
                <li>
                  <strong>Assumptions</strong> (sliders): every behavioural lever — claim
                  probability, abuse share, capture elasticity, retention uplift, breakage,
                  cannibalization, conversion sensitivity, segment mix. These are tunable inputs,
                  not measurements.
                </li>
                <li>
                  <strong>Directional only.</strong> Outputs show the <em>shape</em> of each
                  policy’s trade-off, not a guaranteed dollar figure. The ±
                  {(CONFIDENCE_BAND_SPREAD * 100).toFixed(0)}% band is illustrative.
                </li>
                <li>
                  <strong>Not a fraud predictor.</strong> Abuse leakage is computed from the abuse-
                  share <em>assumption</em> — it is a what-if, not a detection signal.
                </li>
              </ul>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
              <ConstColumn
                title={onDemoData ? "Baseline anchor (DEMO)" : "Baseline anchor (REAL)"}
                rows={realRows.map((r) => ({
                  label: r.label,
                  value: r.value,
                  tag: r.status === "real" ? "real" : "demo",
                }))}
              />
              <ConstColumn
                title="Behavioural assumptions"
                rows={assumptionRows.map((r) => ({ ...r, tag: "assumption" }))}
              />
              <ConstColumn
                title="Model constants"
                rows={constantRows.map((r) => ({ ...r, tag: "constant" }))}
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
  rows: Array<{ label: string; value: string; tag: "real" | "demo" | "assumption" | "constant" }>;
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

function TagDot({ tag }: { tag: "real" | "demo" | "assumption" | "constant" }) {
  const cls =
    tag === "real"
      ? "bg-emerald-500"
      : tag === "demo"
        ? "bg-amber-500"
        : tag === "assumption"
          ? "bg-blue-500"
          : "bg-muted-foreground/50";
  return <span className={cn("size-1.5 shrink-0 rounded-full", cls)} aria-hidden />;
}
