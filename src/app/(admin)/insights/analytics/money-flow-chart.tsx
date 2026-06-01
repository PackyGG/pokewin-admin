"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ComposedChart,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import { formatCompactUsd } from "@/lib/utils/format";

type Point = {
  date: string;
  ggr: number;
  bonuses: number;
  pnl: number;
};

const chartConfig = {
  ggr: { label: "GGR", color: "rgb(59 130 246)" },
  bonuses: { label: "Bonuses paid", color: "rgb(236 72 153)" },
  pnl: { label: "P&L", color: "rgb(16 185 129)" },
} satisfies ChartConfig;

/**
 * Daily time series of GGR, bonus payouts, and P&L over the active
 * window. Visualises the gap between GGR (top line) and P&L (bottom
 * line) at every point — the area between them is what gets eaten by
 * card withdrawals + inventory growth + voucher growth + residual.
 *
 * Composed chart: GGR + P&L as lines, bonuses as bars so admins can
 * see "where did marketing spend spike". A reference line at $0 so
 * negative-P&L days are visually obvious.
 *
 * House-POV colors per CLAUDE.md — P&L positive = emerald (good for
 * house), P&L negative shows up below the $0 reference line in the
 * same color (the LINE is the metric, the SIGN is the indicator). GGR
 * is blue (identity) and bonuses are pink (a cost surface — same hue
 * the Rewards section uses for the rose-adjacent reward family so it
 * reads as "money out").
 */
export function MoneyFlowChart({ data }: { data: Point[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium">
          GGR vs Bonuses vs P&L — daily
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          The gap between GGR (blue) and P&L (emerald) = card withdrawals + inventory growth + voucher growth + residual.
        </p>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[260px] w-full">
          <ComposedChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              tickFormatter={(v) => v.slice(5)}
              fontSize={10}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              width={56}
              tickFormatter={formatCompactUsd}
              fontSize={10}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <ReferenceLine y={0} stroke="rgb(120 120 120)" strokeDasharray="3 3" />
            <Bar
              dataKey="bonuses"
              fill="rgb(236 72 153)"
              fillOpacity={0.6}
              animationDuration={700}
              animationEasing="ease-out"
              radius={[3, 3, 0, 0]}
            />
            <Line
              type="monotone"
              dataKey="ggr"
              stroke="rgb(59 130 246)"
              strokeWidth={2}
              dot={false}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="pnl"
              stroke="rgb(16 185 129)"
              strokeWidth={2}
              dot={false}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

const gapConfig = {
  gap: { label: "GGR − P&L gap", color: "rgb(245 158 11)" },
} satisfies ChartConfig;

/**
 * Daily series of just the gap between GGR and P&L — the daily "loss"
 * that needs explaining via the waterfall above. Drawn as a single
 * bar series with amber tint so it's visually distinct from the main
 * GGR/P&L lines.
 */
export function GapChart({ data }: { data: Point[] }) {
  const gapData = data.map((d) => ({
    date: d.date,
    gap: d.ggr - d.pnl,
  }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium">
          Daily gap — GGR − P&L
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          What flowed out of GGR per day (card withdrawals, inventory growth, voucher growth, residual).
        </p>
      </CardHeader>
      <CardContent>
        <ChartContainer config={gapConfig} className="h-[200px] w-full">
          <BarChart data={gapData} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              tickFormatter={(v) => v.slice(5)}
              fontSize={10}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              width={56}
              tickFormatter={formatCompactUsd}
              fontSize={10}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            <Bar
              dataKey="gap"
              fill="rgb(245 158 11)"
              fillOpacity={0.7}
              animationDuration={700}
              animationEasing="ease-out"
              radius={[3, 3, 0, 0]}
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
