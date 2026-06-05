"use client";

import * as React from "react";
import {
  SlidersHorizontal,
  Percent,
  Coins,
  ShieldAlert,
  Magnet,
  Gauge,
  HandCoins,
  Repeat,
  CalendarRange,
  PieChart,
  TrendingDown,
  Users,
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
import type {
  BaseScenarioConfig,
  LeverConfig,
  LeverIcon,
  SegmentMeta,
  SegmentMixLeverConfig,
} from "../_forecast-engine";
import { formatLeverValue } from "./forecast-format";
import type { AnyAssumptions } from "./forecast-state";

/**
 * Forecast scenario controls — the live levers that drive the engine.
 * REWARD-AGNOSTIC + CONFIG-DRIVEN: the sliders are built from the reward's
 * `levers` (LeverConfig[]) and the optional segment-mix block from its
 * `segments` + `segmentMixLever`.
 *
 * Pure presentational: every change calls back up to the simulator island,
 * which re-runs `simulateSet` in a `useMemo`. NO formulas live here — the math
 * is in each reward's `_forecast/engine.ts`. This component only renders shadcn
 * Slider / Input / Select / Switch + labels + tooltips and reports the next
 * state up.
 */

const HORIZON_PRESETS = [7, 30, 90] as const;

/** Stable lever-icon key → lucide component. Extend with the `LeverIcon` union. */
const LEVER_ICONS: Record<LeverIcon, React.ElementType> = {
  percent: Percent,
  coins: Coins,
  "shield-alert": ShieldAlert,
  magnet: Magnet,
  gauge: Gauge,
  "hand-coins": HandCoins,
  repeat: Repeat,
  "calendar-range": CalendarRange,
  "pie-chart": PieChart,
  "trending-down": TrendingDown,
  users: Users,
};

export type ForecastControlsProps<S extends BaseScenarioConfig> = {
  scenarios: S[];
  activeScenarioId: string;
  onScenarioChange: (id: string) => void;
  assumptions: AnyAssumptions;
  onAssumptionsChange: (next: AnyAssumptions) => void;
  /** The reward's tunable sliders, in display order. */
  levers: LeverConfig[];
  /** Optional segment-mix control block. */
  segmentMixLever?: SegmentMixLeverConfig;
  /** Segment metadata (labels) for the segment-mix block. */
  segments: SegmentMeta[];
  /**
   * Optional secondary (what-if) comparison set toggle. When the reward has a
   * `whatifSet`, the simulator passes `showWhatifSet` + a setter + a label.
   */
  whatif?: {
    label: string;
    hint: string;
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
  };
  /** Reset all levers to their defaults. */
  onReset: () => void;
};

export function ForecastControls<S extends BaseScenarioConfig>({
  scenarios,
  activeScenarioId,
  onScenarioChange,
  assumptions,
  onAssumptionsChange,
  levers,
  segmentMixLever,
  segments,
  whatif,
  onReset,
}: ForecastControlsProps<S>) {
  const setNumeric = React.useCallback(
    (key: string, value: number) => {
      onAssumptionsChange({ ...assumptions, [key]: value });
    },
    [assumptions, onAssumptionsChange],
  );

  const setSegment = React.useCallback(
    (id: string, value: number) => {
      const mixKey = segmentMixLever?.key;
      if (!mixKey) return;
      const currentMix = (assumptions[mixKey] as Record<string, number>) ?? {};
      onAssumptionsChange({
        ...assumptions,
        [mixKey]: { ...currentMix, [id]: value },
      });
    },
    [assumptions, onAssumptionsChange, segmentMixLever],
  );

  const mix = segmentMixLever
    ? ((assumptions[segmentMixLever.key] as Record<string, number>) ?? {})
    : {};
  const mixTotal =
    segments.reduce((a, s) => a + Math.max(0, mix[s.id] ?? 0), 0) || 1;

  const windowDays = Number(assumptions.windowDays) || 0;

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

          {/* ── Active scenario + comparison set ─────────────────────── */}
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

            {whatif && (
              <ToggleRow
                label={whatif.label}
                hint={whatif.hint}
                checked={whatif.checked}
                onCheckedChange={whatif.onCheckedChange}
              />
            )}
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
                  onClick={() => setNumeric("windowDays", d)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    windowDays === d
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {/* ── Config-driven levers ───────────────────────────────── */}
          {levers.map((lever) => (
            <React.Fragment key={lever.key}>
              {lever.groupBreak && <Divider />}
              <SliderRow
                lever={lever}
                value={Number(assumptions[lever.key]) || 0}
                onChange={(v) => setNumeric(lever.key, v)}
              />
            </React.Fragment>
          ))}

          {/* ── Segment mix (optional) ─────────────────────────────── */}
          {segmentMixLever && segments.length > 0 && (
            <>
              <Divider />
              <div className="space-y-3">
                <Label className="text-xs">
                  <PieChart className="size-3.5" />
                  {segmentMixLever.label}
                  <span className="ml-1 font-normal text-muted-foreground">
                    (auto-normalized)
                  </span>
                </Label>
                <div className="space-y-2.5">
                  {segments.map((seg) => {
                    const raw = Math.max(0, mix[seg.id] ?? 0);
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
            </>
          )}
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
  lever,
  value,
  onChange,
}: {
  lever: LeverConfig;
  value: number;
  onChange: (v: number) => void;
}) {
  const { label, hint, icon, min, max, step, format, decimals, accent } = lever;
  const Icon = LEVER_ICONS[icon] ?? Gauge;

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
          {formatLeverValue(value, format, decimals)}
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
