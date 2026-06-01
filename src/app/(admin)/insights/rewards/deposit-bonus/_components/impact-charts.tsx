"use client";

import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { BarChart3, Clock, Layers } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

/**
 * Charts for the Impact tab. Each mirrors the rose/blue family + tooltip
 * pattern of `cap-histogram-chart.tsx` so the whole deposit-bonus surface
 * reads as one design.
 *
 * House-POV: deposit COUNTS are the neutral activity signal → blue. The
 * deposit-size histogram tints the ≥ $500 "whale" bands rose, because
 * those are the deposits a tighter time-split cap would throttle (a
 * cost-side lens). Time-gap distribution is blue (pure timing, no money).
 */

const BLUE = "#3b82f6";
const ROSE = "#f43f5e";

// ─── Deposit-frequency distribution ─────────────────────────────────

const frequencyConfig = {
  userDays: { label: "User-days", color: BLUE },
} satisfies ChartConfig;

export function DepositFrequencyChart({
  buckets,
}: {
  buckets: Array<{ label: string; userDays: number; share: number }>;
}) {
  if (buckets.every((b) => b.userDays === 0)) {
    return (
      <EmptyState
        icon={Layers}
        title="No deposit activity"
        description="No completed deposits in window to bucket by frequency."
        compact
      />
    );
  }
  return (
    <ChartContainer
      config={frequencyConfig}
      className="aspect-auto h-[240px] w-full md:h-[280px]"
    >
      <BarChart data={buckets} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          tick={{ fontSize: 12 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={48}
          tickFormatter={(v: number) => formatNumber(v)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, _name, item) => {
                const share = (item?.payload as { share?: number } | undefined)?.share;
                return `${formatNumber(Number(value))} user-days · ${((share ?? 0) * 100).toFixed(1)}%`;
              }}
              hideIndicator
            />
          }
        />
        <Bar
          dataKey="userDays"
          fill={BLUE}
          radius={[4, 4, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}

// ─── Deposit-size distribution ──────────────────────────────────────

const sizeConfig = {
  count: { label: "Deposits", color: BLUE },
} satisfies ChartConfig;

export function DepositSizeChart({
  buckets,
}: {
  buckets: Array<{
    label: string;
    count: number;
    volume: number;
    countShare: number;
    isLarge: boolean;
  }>;
}) {
  if (buckets.every((b) => b.count === 0)) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No deposits to distribute"
        description="No completed deposits in window."
        compact
      />
    );
  }
  return (
    <ChartContainer
      config={sizeConfig}
      className="aspect-auto h-[240px] w-full md:h-[300px]"
    >
      <BarChart data={buckets} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          tick={{ fontSize: 10 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={48}
          tickFormatter={(v: number) => formatNumber(v)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, _name, item) => {
                const payload = item?.payload as
                  | { volume?: number; countShare?: number }
                  | undefined;
                return `${formatNumber(Number(value))} deposits · ${((payload?.countShare ?? 0) * 100).toFixed(1)}% · ${formatCurrency(payload?.volume ?? 0)} vol`;
              }}
              hideIndicator
            />
          }
        />
        <Bar
          dataKey="count"
          radius={[4, 4, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        >
          {buckets.map((b) => (
            // ≥ $500 bands tinted rose — those are the deposits a tighter
            // time-split cap would throttle (cost-side highlight).
            <Cell key={b.label} fill={b.isLarge ? ROSE : BLUE} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ─── Time-between-deposits distribution ─────────────────────────────

const gapConfig = {
  count: { label: "Gaps", color: BLUE },
} satisfies ChartConfig;

export function TimeGapChart({
  buckets,
}: {
  buckets: Array<{ label: string; count: number; share: number }>;
}) {
  if (buckets.every((b) => b.count === 0)) {
    return (
      <EmptyState
        icon={Clock}
        title="No consecutive deposits"
        description="Users need ≥ 2 deposits in window to measure a gap."
        compact
      />
    );
  }
  return (
    <ChartContainer
      config={gapConfig}
      className="aspect-auto h-[240px] w-full md:h-[280px]"
    >
      <BarChart data={buckets} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          tick={{ fontSize: 11 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={48}
          tickFormatter={(v: number) => formatNumber(v)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, _name, item) => {
                const share = (item?.payload as { share?: number } | undefined)?.share;
                return `${formatNumber(Number(value))} gaps · ${((share ?? 0) * 100).toFixed(1)}%`;
              }}
              hideIndicator
            />
          }
        />
        <Bar
          dataKey="count"
          fill={BLUE}
          radius={[4, 4, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}
