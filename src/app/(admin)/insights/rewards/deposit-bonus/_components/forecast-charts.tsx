"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { SEGMENTS, type SimulationResult } from "../_forecast";

/**
 * Forecast charts (section 4). All recharts via the house `ChartContainer`,
 * `animationDuration={700}` / `animationEasing="ease-out"`, motion handled by
 * recharts' own animation (the page wraps blocks in `FadeIn`, which is
 * reduce-motion aware).
 *
 * House-POV palette:
 *   • cost / cumulative cost / abuse leakage = house OUTFLOW → rose / amber.
 *   • savings vs baseline = house GAIN → emerald.
 *   • per-segment contribution uses each segment's stable accent hue.
 *
 * Every series is pre-shaped by the simulator (which owns the engine calls);
 * these components hold ZERO economics — they only render.
 */

const ROSE = "#f43f5e";
const EMERALD = "#10b981";
const AMBER = "#f59e0b";
const BLUE = "#3b82f6";

// Stable per-segment hex (matches the modern-panels accent family).
const SEGMENT_HEX: Record<string, string> = {
  legit_low_risk: EMERALD,
  high_value: "#a855f7", // purple
  promo_sensitive: AMBER,
  high_risk_abuse: ROSE,
  reactivated_dormant: "#06b6d4", // cyan
};

// ─── 1. Cost over time (active scenario) ────────────────────────────

const costConfig = {
  bonusCost: { label: "Daily bonus cost", color: ROSE },
} satisfies ChartConfig;

export function CostOverTimeChart({ result }: { result: SimulationResult }) {
  const data = result.dailySeries.map((d) => ({
    day: `D${d.day + 1}`,
    bonusCost: d.bonusCost,
  }));
  return (
    <ChartContainer config={costConfig} className="aspect-auto h-[220px] w-full md:h-[260px]">
      <AreaChart data={data} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <defs>
          <linearGradient id="forecastCostGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ROSE} stopOpacity={0.35} />
            <stop offset="100%" stopColor={ROSE} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tick={{ fontSize: 11 }} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={56} tickFormatter={formatCompactUsd} />
        <ChartTooltip
          content={<ChartTooltipContent formatter={(v) => formatCurrency(Number(v))} hideIndicator />}
        />
        <Area
          type="monotone"
          dataKey="bonusCost"
          stroke={ROSE}
          fill="url(#forecastCostGradient)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}

// ─── 2. Cumulative cost (active scenario) ───────────────────────────

const cumulativeConfig = {
  cumulativeCost: { label: "Cumulative cost", color: ROSE },
} satisfies ChartConfig;

export function CumulativeCostChart({ result }: { result: SimulationResult }) {
  const data = result.dailySeries.map((d) => ({
    day: `D${d.day + 1}`,
    cumulativeCost: d.cumulativeCost,
  }));
  return (
    <ChartContainer config={cumulativeConfig} className="aspect-auto h-[220px] w-full md:h-[260px]">
      <AreaChart data={data} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <defs>
          <linearGradient id="forecastCumGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ROSE} stopOpacity={0.3} />
            <stop offset="100%" stopColor={ROSE} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tick={{ fontSize: 11 }} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={56} tickFormatter={formatCompactUsd} />
        <ChartTooltip
          content={<ChartTooltipContent formatter={(v) => formatCurrency(Number(v))} hideIndicator />}
        />
        <Area
          type="monotone"
          dataKey="cumulativeCost"
          stroke={ROSE}
          fill="url(#forecastCumGradient)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}

// ─── 3. Net savings vs baseline (per scenario) ──────────────────────

const savingsConfig = {
  netSavings: { label: "Net savings", color: EMERALD },
} satisfies ChartConfig;

export function SavingsByScenarioChart({
  rows,
  baselineId,
}: {
  rows: Array<{ id: string; label: string; result: SimulationResult }>;
  baselineId: string;
}) {
  const data = rows
    .filter((r) => r.id !== baselineId)
    .map((r) => ({
      label: shortLabel(r.label),
      netSavings: r.result.netSavingsVsBaseline,
    }));
  return (
    <ChartContainer config={savingsConfig} className="aspect-auto h-[220px] w-full md:h-[260px]">
      <BarChart data={data} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} tick={{ fontSize: 10 }} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={56} tickFormatter={formatCompactUsd} />
        <ChartTooltip
          content={<ChartTooltipContent formatter={(v) => formatCurrency(Number(v))} hideIndicator />}
        />
        <Bar dataKey="netSavings" radius={[4, 4, 0, 0]} animationDuration={700} animationEasing="ease-out">
          {data.map((d) => (
            // Positive net savings = house gain → emerald; negative = rose.
            <Cell key={d.label} fill={d.netSavings >= 0 ? EMERALD : ROSE} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ─── 4. Abuse leakage per model ─────────────────────────────────────

const leakageConfig = {
  abuseLeakage: { label: "Abuse leakage", color: AMBER },
} satisfies ChartConfig;

export function AbuseLeakageChart({
  rows,
  baselineId,
}: {
  rows: Array<{ id: string; label: string; result: SimulationResult }>;
  baselineId: string;
}) {
  const data = rows.map((r) => ({
    label: shortLabel(r.label),
    abuseLeakage: r.result.abuseLeakage,
    isBaseline: r.id === baselineId,
  }));
  return (
    <ChartContainer config={leakageConfig} className="aspect-auto h-[220px] w-full md:h-[260px]">
      <BarChart data={data} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} tick={{ fontSize: 10 }} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={56} tickFormatter={formatCompactUsd} />
        <ChartTooltip
          content={<ChartTooltipContent formatter={(v) => formatCurrency(Number(v))} hideIndicator />}
        />
        <Bar dataKey="abuseLeakage" radius={[4, 4, 0, 0]} animationDuration={700} animationEasing="ease-out">
          {data.map((d) => (
            // Baseline leakage is the reference (amber); the rest also amber —
            // the point of the chart is which model leaks LESS than baseline.
            <Cell key={d.label} fill={d.isBaseline ? ROSE : AMBER} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ─── 5. Segment cost contribution (stacked) ─────────────────────────

const segmentConfig = SEGMENTS.reduce((acc, s) => {
  acc[s.id] = { label: s.label, color: SEGMENT_HEX[s.id] };
  return acc;
}, {} as ChartConfig);

export function SegmentContributionChart({
  rows,
}: {
  rows: Array<{ id: string; label: string; result: SimulationResult }>;
}) {
  // Each bar = a scenario; stacked by per-segment bonus cost.
  const data = rows.map((r) => {
    const row: Record<string, number | string> = { label: shortLabel(r.label) };
    for (const seg of r.result.perSegment) row[seg.segment] = seg.bonusCost;
    return row;
  });
  return (
    <ChartContainer config={segmentConfig} className="aspect-auto h-[240px] w-full md:h-[280px]">
      <BarChart data={data} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} tick={{ fontSize: 10 }} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={56} tickFormatter={formatCompactUsd} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => {
                const seg = SEGMENTS.find((s) => s.id === name);
                return `${seg?.label ?? String(name)}: ${formatCurrency(Number(value))}`;
              }}
            />
          }
        />
        {SEGMENTS.map((seg, i) => (
          <Bar
            key={seg.id}
            dataKey={seg.id}
            stackId="cost"
            fill={SEGMENT_HEX[seg.id]}
            radius={i === SEGMENTS.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
            animationDuration={700}
            animationEasing="ease-out"
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

// ─── 6. Sensitivity sweep (one lever ± range vs cost) ───────────────

const sensitivityConfig = {
  bonusCost: { label: "Projected cost", color: BLUE },
} satisfies ChartConfig;

export type SensitivityPoint = { x: number; label: string; bonusCost: number };

export function SensitivityChart({
  points,
  xUnit,
}: {
  points: SensitivityPoint[];
  xUnit: string;
}) {
  return (
    <ChartContainer config={sensitivityConfig} className="aspect-auto h-[220px] w-full md:h-[260px]">
      <LineChart data={points} margin={{ left: 6, right: 12, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
          minTickGap={28}
          tick={{ fontSize: 10 }}
        />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={56} tickFormatter={formatCompactUsd} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_l, payload) => {
                const p = payload?.[0]?.payload as SensitivityPoint | undefined;
                return p ? `${p.label} ${xUnit}` : "";
              }}
              formatter={(v) => formatCurrency(Number(v))}
              hideIndicator
            />
          }
        />
        <Line
          type="monotone"
          dataKey="bonusCost"
          stroke={BLUE}
          strokeWidth={2}
          dot={false}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </LineChart>
    </ChartContainer>
  );
}

// ─── helpers ────────────────────────────────────────────────────────

/** Trim the "A · " / "E · " prefixes for compact axis labels. */
function shortLabel(label: string): string {
  return label.replace(/^[A-E]\s·\s/, "");
}
