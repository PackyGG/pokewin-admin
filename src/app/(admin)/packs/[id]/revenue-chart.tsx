"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, XAxis, YAxis } from "recharts";
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
  soloOpenings: { label: "Solo", color: "var(--color-chart-1)" },
  battleOpenings: { label: "Battles", color: "var(--color-chart-2)" },
  borrowedOpenings: { label: "Borrowed", color: "var(--color-chart-4)" },
  sponsoredOpenings: { label: "Sponsored", color: "var(--color-chart-5)" },
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
  const hasDaily = chartData.length > 0;

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
                      <div
                        className={`font-semibold tabular-nums ${
                          typeof rtp === "string" && parseFloat(rtp) > 100
                            ? "text-red-400"
                            : ""
                        }`}
                      >
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
      {hasDaily && (
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
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Revenue + Payout chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Revenue & Payout
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!hasDaily ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No daily breakdown — totals from DB shown above
              </p>
            ) : (
              <ChartContainer
                config={revenueConfig}
                className="h-[250px] w-full"
              >
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
                        formatter={(value) =>
                          `$${Number(value).toFixed(2)}`
                        }
                      />
                    }
                  />
                  <Legend
                    verticalAlign="top"
                    height={28}
                    iconType="square"
                    iconSize={10}
                    formatter={(value: string) =>
                      value === "revenue" ? "Revenue" : "Payout"
                    }
                    wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }}
                  />
                  <Bar
                    dataKey="revenue"
                    fill="var(--color-revenue)"
                    radius={[4, 4, 0, 0]}
                    name="Revenue"
                  />
                  <Bar
                    dataKey="payout"
                    fill="var(--color-payout)"
                    radius={[4, 4, 0, 0]}
                    name="Payout"
                  />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Openings chart — stacked: solo + battles, with borrowed/sponsored overlay */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Daily Openings (solo / battles / borrowed / sponsored)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!hasDaily ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No daily breakdown — totals from DB shown above
              </p>
            ) : (
              <ChartContainer
                config={openingsConfig}
                className="h-[250px] w-full"
              >
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
                    width={30}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend
                    verticalAlign="top"
                    height={28}
                    iconType="square"
                    iconSize={10}
                    wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }}
                  />
                  <Bar
                    dataKey="soloOpenings"
                    stackId="opens"
                    fill="var(--color-soloOpenings)"
                    name="Solo"
                  />
                  <Bar
                    dataKey="battleOpenings"
                    stackId="opens"
                    fill="var(--color-battleOpenings)"
                    radius={[4, 4, 0, 0]}
                    name="Battles"
                  />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
