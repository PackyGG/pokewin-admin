"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { PackStats } from "@/lib/queries/packs";

const RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 0 },
];

const revenueConfig = {
  revenue: { label: "Revenue", color: "var(--color-chart-1)" },
  payout: { label: "Payout", color: "var(--color-chart-4)" },
} satisfies ChartConfig;

const openingsConfig = {
  openings: { label: "Openings", color: "var(--color-chart-2)" },
} satisfies ChartConfig;

const formatValue = (v: number) => {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};

const PERIOD_KEYS = ["d1", "d3", "d7", "d30", "all"] as const;
const PERIOD_LABELS: Record<string, string> = {
  d1: "24h",
  d3: "3d",
  d7: "7d",
  d30: "30d",
  all: "All",
};

export function PackStatsSection({ stats }: { stats: PackStats }) {
  const [range, setRange] = useState(30);

  const filtered =
    range > 0
      ? (() => {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - range);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          return stats.daily.filter((d) => d.date >= cutoffStr);
        })()
      : stats.daily;

  const chartData = filtered.length > 0 ? filtered : stats.daily;

  return (
    <div className="space-y-4">
      {/* Period stats tiles */}
      <Card>
        <CardContent className="pt-5">
          <div className="grid grid-cols-5 gap-3">
            {PERIOD_KEYS.map((k) => {
              const rev = stats.revenue[k];
              const pay = stats.payout[k];
              const rtp = rev > 0 ? ((pay / rev) * 100).toFixed(1) : "—";
              return (
                <div key={k} className="rounded-lg border bg-card/40 p-3 text-center">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {PERIOD_LABELS[k]}
                  </div>
                  <div className="mt-1 text-lg font-bold tabular-nums">
                    {formatNumber(stats.openings[k])}
                  </div>
                  <div className="text-[10px] text-muted-foreground">openings</div>
                  <div className="mt-1.5 grid grid-cols-2 gap-1 text-[10px]">
                    <div>
                      <span className="text-muted-foreground">Rev</span>
                      <div className="font-semibold tabular-nums">
                        {formatCurrency(rev)}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">RTP</span>
                      <div className={`font-semibold tabular-nums ${Number(rtp) > 100 ? "text-red-400" : ""}`}>
                        {rtp}%
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Range filter */}
      <div className="flex items-center gap-1">
        {RANGES.map((r) => (
          <Button
            key={r.label}
            variant={range === r.days ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setRange(r.days)}
          >
            {r.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Revenue + Payout chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Revenue & Payout</CardTitle>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No data yet
              </p>
            ) : (
              <ChartContainer config={revenueConfig} className="h-[250px] w-full">
                <BarChart data={chartData} accessibilityLayer>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(v) => v.slice(5)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    width={60}
                    tickFormatter={formatValue}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) => `$${Number(value).toFixed(2)}`}
                      />
                    }
                  />
                  <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="payout" fill="var(--color-payout)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Openings chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Daily Openings</CardTitle>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No data yet
              </p>
            ) : (
              <ChartContainer config={openingsConfig} className="h-[250px] w-full">
                <LineChart data={chartData} accessibilityLayer>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(v) => v.slice(5)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    width={40}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line
                    type="monotone"
                    dataKey="openings"
                    stroke="var(--color-openings)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
