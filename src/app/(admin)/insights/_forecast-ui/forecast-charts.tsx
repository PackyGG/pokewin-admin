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
import type { AccentColor, SegmentMeta, SimulationResult } from "../_forecast-engine";
import { shortScenarioLabel } from "./forecast-format";

/**
 * Forecast charts — REWARD-AGNOSTIC. All recharts via the house
 * `ChartContainer`, `animationDuration={700}` / `animationEasing="ease-out"`;
 * motion is reduce-motion aware via the `FadeIn` wrappers the simulator uses.
 *
 * House-POV palette (CLAUDE.md, strict):
 *   • cost / cumulative cost / abuse leakage = house OUTFLOW → rose / amber.
 *   • savings vs baseline = house GAIN → emerald.
 *   • per-segment contribution uses each segment's stable accent hue (from the
 *     reward's `SegmentMeta`).
 *
 * Every series is pre-shaped by the simulator (which owns the engine calls);
 * these components hold ZERO economics — they only render.
 */

const ROSE = "#f43f5e";
const EMERALD = "#10b981";
const AMBER = "#f59e0b";
const BLUE = "#3b82f6";

/** Map a TILE_COLORS accent token to a stable chart hex (house palette). */
const ACCENT_HEX: Record<AccentColor, string> = {
  blue: BLUE,
  emerald: EMERALD,
  rose: ROSE,
  cyan: "#06b6d4",
  amber: AMBER,
  purple: "#a855f7",
  orange: "#f97316",
  pink: "#ec4899",
};

export function segmentHex(seg: SegmentMeta): string {
  return ACCENT_HEX[seg.accent] ?? BLUE;
}

// ─── 1. Cost over time (active scenario) ────────────────────────────

const costConfig = {
  bonusCost: { label: "Daily cost", color: ROSE },
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
      label: shortScenarioLabel(r.label),
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
    label: shortScenarioLabel(r.label),
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
            // The point of the chart is which model leaks LESS than baseline:
            // the baseline reads rose (the reference outflow), the rest amber.
            <Cell key={d.label} fill={d.isBaseline ? ROSE : AMBER} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ─── 5. Segment cost contribution (stacked) ─────────────────────────

export function SegmentContributionChart({
  rows,
  segments,
}: {
  rows: Array<{ id: string; label: string; result: SimulationResult }>;
  segments: SegmentMeta[];
}) {
  const segmentConfig = React.useMemo(() => {
    return segments.reduce((acc, s) => {
      acc[s.id] = { label: s.label, color: segmentHex(s) };
      return acc;
    }, {} as ChartConfig);
  }, [segments]);

  // Each bar = a scenario; stacked by per-segment cost.
  const data = rows.map((r) => {
    const row: Record<string, number | string> = { label: shortScenarioLabel(r.label) };
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
                const seg = segments.find((s) => s.id === name);
                return `${seg?.label ?? String(name)}: ${formatCurrency(Number(value))}`;
              }}
            />
          }
        />
        {segments.map((seg, i) => (
          <Bar
            key={seg.id}
            dataKey={seg.id}
            stackId="cost"
            fill={segmentHex(seg)}
            radius={i === segments.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
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
