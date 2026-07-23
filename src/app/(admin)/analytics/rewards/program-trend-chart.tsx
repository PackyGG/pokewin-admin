"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { TrendingDown } from "lucide-react";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { PROGRAM_META } from "./program-meta";
import type { RewardProgramKey } from "@/lib/queries/insights-rewards/program-spend";

export type ProgramTrendPoint = { date: string } & Partial<
  Record<RewardProgramKey, number>
>;

/**
 * Stacked daily cost by program.
 *
 * Replaces the old single rose "total reward cost" area, which showed the
 * shape of the spend but never WHICH program moved — the one question an
 * operator asks when the line jumps. Stacking keeps the total readable (the
 * top of the stack is still the daily total) while attributing every dollar.
 *
 * Series come from the server pre-ordered biggest-first, and are rendered in
 * reverse so the largest program sits at the bottom of the stack where the
 * eye lands first. Colours are the per-program hues from `PROGRAM_META`, the
 * same ones the cards put on their icons.
 */
export function ProgramTrendChart({
  data,
  programs,
  labels,
  height = 300,
}: {
  data: ProgramTrendPoint[];
  /** Program keys present in the window, biggest spend first. */
  programs: RewardProgramKey[];
  labels: Record<string, string>;
  height?: number;
}) {
  if (data.length === 0 || programs.length === 0) {
    return (
      <EmptyState
        icon={TrendingDown}
        title="No reward spend in this window"
        description="Nothing was paid out by any program in the selected period. Try a longer window."
        compact
      />
    );
  }

  const chartConfig = Object.fromEntries(
    programs.map((key) => [
      key,
      { label: labels[key] ?? key, color: PROGRAM_META[key].chartColor },
    ]),
  ) satisfies ChartConfig;

  // Bottom of the stack = biggest program. recharts stacks in render order,
  // so the incoming biggest-first list is reversed here.
  const stackOrder = [...programs].reverse();

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto w-full"
      style={{ height }}
    >
      <AreaChart data={data} margin={{ left: 6, right: 6 }} accessibilityLayer>
        <defs>
          {programs.map((key) => (
            <linearGradient
              key={key}
              id={`rewardProgram-${key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor={PROGRAM_META[key].chartColor}
                stopOpacity={0.45}
              />
              <stop
                offset="100%"
                stopColor={PROGRAM_META[key].chartColor}
                stopOpacity={0.06}
              />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={70}
          tickFormatter={formatCompactUsd}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="text-muted-foreground">
                    {labels[String(name)] ?? String(name)}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatCurrency(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
        {stackOrder.map((key) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stackId="cost"
            stroke={PROGRAM_META[key].chartColor}
            strokeWidth={1.5}
            fill={`url(#rewardProgram-${key})`}
            animationDuration={700}
            animationEasing="ease-out"
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}
