"use client";

import * as React from "react";
import {
  SlidersHorizontal,
  Users,
  Percent,
  Coins,
  ShieldAlert,
  Magnet,
  Gauge,
  HandCoins,
  Repeat,
  CalendarRange,
  PieChart,
  RotateCcw,
} from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { formatPct } from "../../../edge-calc/math";

import type { Assumptions, ScenarioConfig, SegmentId } from "../_forecast";
import { SEGMENTS } from "../_forecast";

/**
 * Forecast scenario controls — the live levers that drive the engine.
 *
 * Pure presentational: every change calls back up to the simulator island,
 * which re-runs `simulateSet` in a `useMemo`. NO formulas live here (per the
 * brief — the math is in `_forecast/engine.ts`). This component only renders
 * shadcn Slider / Input / Select / Switch + labels + tooltips and reports the
 * next state up.
 *
 * Why sliders + numeric inputs both: the slider gives a fast tactile sweep,
 * the input lets an operator type an exact value. They share state.
 */

const HORIZON_PRESETS = [7, 30, 90] as const;

export type ForecastControlsProps = {
  scenarios: ScenarioConfig[];
  activeScenarioId: string;
  onScenarioChange: (id: string) => void;
  assumptions: Assumptions;
  onAssumptionsChange: (next: Assumptions) => void;
  /** Whether the real production baseline is in use (vs DEMO). */
  useRealBaseline: boolean;
  onUseRealBaselineChange: (next: boolean) => void;
  /** Whether the comparison table shows the split-cap set vs the full library. */
  showSplitCapSet: boolean;
  onShowSplitCapSetChange: (next: boolean) => void;
  /** Reset all levers to their DEMO defaults. */
  onReset: () => void;
  /** True when a real baseline exists to toggle to (server fetch succeeded). */
  realBaselineAvailable: boolean;
};

export function ForecastControls({
  scenarios,
  activeScenarioId,
  onScenarioChange,
  assumptions,
  onAssumptionsChange,
  useRealBaseline,
  onUseRealBaselineChange,
  showSplitCapSet,
  onShowSplitCapSetChange,
  onReset,
  realBaselineAvailable,
}: ForecastControlsProps) {
  const set = React.useCallback(
    <K extends keyof Assumptions>(key: K, value: Assumptions[K]) => {
      onAssumptionsChange({ ...assumptions, [key]: value });
    },
    [assumptions, onAssumptionsChange],
  );

  const setSegment = React.useCallback(
    (id: SegmentId, value: number) => {
      onAssumptionsChange({
        ...assumptions,
        segmentMix: { ...assumptions.segmentMix, [id]: value },
      });
    },
    [assumptions, onAssumptionsChange],
  );

  // Segment mix shares for display (normalized to a percentage of the total).
  const mixTotal =
    SEGMENTS.reduce((a, s) => a + Math.max(0, assumptions.segmentMix[s.id] ?? 0), 0) || 1;

  return (
    <TooltipProvider delay={150}>
      <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-blue-500/[0.08] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
        />
        <div className="relative space-y-5 p-4 sm:p-5">
          <SectionHeading
            icon={SlidersHorizontal}
            title="Scenario controls"
            action={
              <button
                type="button"
                onClick={onReset}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <RotateCcw className="size-3" />
                Reset
              </button>
            }
          />

          {/* ── Active scenario + data source ──────────────────────── */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="forecast-scenario" className="text-xs">
                <Gauge className="size-3.5" />
                Active scenario
              </Label>
              <Select
                value={activeScenarioId}
                onValueChange={(v) => v && onScenarioChange(String(v))}
              >
                <SelectTrigger id="forecast-scenario" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scenarios.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {scenarios.find((s) => s.id === activeScenarioId)?.description ?? ""}
              </p>
            </div>

            <ToggleRow
              label="Use real baseline"
              hint={
                realBaselineAvailable
                  ? "Swap the DEMO cost / claimant / cap / ROI anchor for the real production numbers (fetched server-side). Behavioural assumptions below stay tunable."
                  : "No real baseline available for this period — the production query returned nothing, so the DEMO anchor is used."
              }
              checked={useRealBaseline}
              disabled={!realBaselineAvailable}
              onCheckedChange={onUseRealBaselineChange}
            />
            <ToggleRow
              label="Compare split-cap set"
              hint="Table shows the focused split-cap what-if rows (100/24h, 10/hr, 5/hr, 20/6h, 15/6h, 50/12h, 75/24h). Off = the full A–E library."
              checked={showSplitCapSet}
              onCheckedChange={onShowSplitCapSetChange}
            />
          </div>

          <Divider />

          {/* ── Horizon ────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              <CalendarRange className="size-3.5" />
              Forecast horizon
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {HORIZON_PRESETS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => set("windowDays", d)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    assumptions.windowDays === d
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {/* ── Volume levers ──────────────────────────────────────── */}
          <SliderRow
            label="Eligible users"
            hint="Population modeled in one cap window. Scales total claimants and cost linearly."
            icon={Users}
            value={assumptions.eligibleUsers}
            min={0}
            max={50000}
            step={500}
            onChange={(v) => set("eligibleUsers", v)}
            format={(v) => formatNumber(Math.round(v))}
          />
          <SliderRow
            label="Deposits / user / window"
            hint="Baseline deposit frequency per eligible user within one cap window."
            icon={Repeat}
            value={assumptions.depositsPerUserPerWindow}
            min={0}
            max={5}
            step={0.1}
            onChange={(v) => set("depositsPerUserPerWindow", v)}
            format={(v) => v.toFixed(1)}
          />
          <SliderRow
            label="Claim probability"
            hint="P(claims a bonus | deposited). DEMO assumption."
            icon={Percent}
            value={assumptions.claimProbability}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set("claimProbability", v)}
            format={formatPct}
          />
          <SliderRow
            label="Avg bonus (USD)"
            hint="Baseline average bonus before the cap clamp. The engine clamps this to each segment's effective cap."
            icon={Coins}
            value={assumptions.avgBonusUsd}
            min={0}
            max={250}
            step={1}
            onChange={(v) => set("avgBonusUsd", v)}
            format={(v) => formatCurrency(v)}
          />

          <Divider />

          {/* ── Behavioural levers ─────────────────────────────────── */}
          <SliderRow
            label="Abuse share"
            hint="Share of claimants behaving abusively AT the baseline cap. DEMO assumption — this is a tunable scenario input, not a fraud prediction."
            icon={ShieldAlert}
            value={assumptions.abuseShare}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(v) => set("abuseShare", v)}
            format={formatPct}
            accent="amber"
          />
          <SliderRow
            label="Abuse-capture elasticity"
            hint="How strongly stricter caps suppress abuse (1 = fully elastic). Higher → tightening kills more leakage."
            icon={ShieldAlert}
            value={assumptions.abuseCaptureElasticity}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set("abuseCaptureElasticity", v)}
            format={formatPct}
            accent="amber"
          />
          <SliderRow
            label="Retention uplift"
            hint="Incremental retained revenue per $1 of legit bonus. Higher → bonuses pay back more downstream."
            icon={HandCoins}
            value={assumptions.retentionUplift}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set("retentionUplift", v)}
            format={formatPct}
            accent="emerald"
          />
          <SliderRow
            label="Breakage rate"
            hint="Share of awarded bonus never wagered (expired / unused). Shrinks the retention base — the bonus is still a cost."
            icon={Percent}
            value={assumptions.breakageRate}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set("breakageRate", v)}
            format={formatPct}
          />
          <SliderRow
            label="Cannibalization rate"
            hint="Share of bonus paid to users who'd have deposited anyway. Rises further above a $150 cap (over-generous)."
            icon={Magnet}
            value={assumptions.cannibalizationRate}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set("cannibalizationRate", v)}
            format={formatPct}
          />
          <SliderRow
            label="Legit conversion sensitivity"
            hint="Legit conversion lost per unit of cap tightening. Higher → stricter caps sacrifice more genuine signups → net savings < gross."
            icon={Gauge}
            value={assumptions.legitConversionSensitivity}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set("legitConversionSensitivity", v)}
            format={formatPct}
          />

          <Divider />

          {/* ── Segment mix ────────────────────────────────────────── */}
          <div className="space-y-3">
            <Label className="text-xs">
              <PieChart className="size-3.5" />
              Segment mix
              <span className="ml-1 font-normal text-muted-foreground">
                (auto-normalized)
              </span>
            </Label>
            <div className="space-y-2.5">
              {SEGMENTS.map((seg) => {
                const raw = Math.max(0, assumptions.segmentMix[seg.id] ?? 0);
                const sharePct = (raw / mixTotal) * 100;
                return (
                  <div key={seg.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate text-muted-foreground">{seg.label}</span>
                      <span className="shrink-0 tabular-nums font-medium">
                        {sharePct.toFixed(0)}%
                      </span>
                    </div>
                    <Slider
                      aria-label={`${seg.label} share`}
                      value={raw}
                      min={0}
                      max={1}
                      step={0.01}
                      onValueChange={(v) => setSegment(seg.id, v)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ─── Inline helpers ──────────────────────────────────────────────────

function Divider() {
  return <div aria-hidden className="h-px bg-border/50" />;
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-xs">{label}</Label>
        <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

function SliderRow({
  label,
  hint,
  icon: Icon,
  value,
  min,
  max,
  step,
  onChange,
  format,
  accent,
}: {
  label: string;
  hint: string;
  icon: React.ElementType;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  accent?: "amber" | "emerald";
}) {
  // The numeric input mirrors the slider; typing snaps within [min,max].
  const commit = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    onChange(Math.min(max, Math.max(min, raw)));
  };
  const accentText =
    accent === "amber"
      ? "text-amber-600 dark:text-amber-400"
      : accent === "emerald"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-foreground";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Label className="cursor-help text-xs">
                <Icon className="size-3.5" />
                {label}
              </Label>
            }
          />
          <TooltipContent className="max-w-[240px] text-xs leading-relaxed">
            {hint}
          </TooltipContent>
        </Tooltip>
        <span className={cn("shrink-0 text-xs font-semibold tabular-nums", accentText)}>
          {format(value)}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Slider
          aria-label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          onValueChange={commit}
          className="flex-1"
        />
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => commit(Number(e.target.value))}
          className="h-7 w-20 shrink-0 text-right text-xs"
        />
      </div>
    </div>
  );
}
