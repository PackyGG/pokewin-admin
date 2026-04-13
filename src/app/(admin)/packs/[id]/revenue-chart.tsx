"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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

const PIE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

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

const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "12px",
  padding: "6px 10px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
};
const tooltipItemStyle = { color: "var(--foreground)" };
const tooltipLabelStyle = { color: "var(--muted-foreground)", marginBottom: 2 };

export function PackStatsSection({ stats }: { stats: PackStats }) {
  const [range, setRange] = useState(30);

  const filtered = useMemo(() => {
    if (range === 0) return stats.daily;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - range);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const f = stats.daily.filter((d) => d.date >= cutoffStr);
    return f.length > 0 ? f : stats.daily;
  }, [stats.daily, range]);

  const hasDaily = stats.daily.length > 0;

  // Aggregate for pie chart
  const totals = useMemo(() => {
    let solo = 0, battle = 0, borrowed = 0, sponsored = 0, normal = 0;
    for (const d of stats.daily) {
      solo += d.soloOpenings;
      battle += d.battleOpenings;
      borrowed += d.borrowedOpenings;
      sponsored += d.sponsoredOpenings;
    }
    normal = solo + battle - borrowed - sponsored;
    if (normal < 0) normal = 0;
    return { solo, battle, borrowed, sponsored, normal, total: solo + battle };
  }, [stats.daily]);

  const pieData = useMemo(() => {
    const items: { name: string; value: number }[] = [];
    if (totals.solo > 0) items.push({ name: "Solo", value: totals.solo });
    if (totals.battle > 0) {
      const normalBattle = totals.battle - totals.borrowed - totals.sponsored;
      if (normalBattle > 0)
        items.push({ name: "Battle (normal)", value: normalBattle });
      if (totals.borrowed > 0)
        items.push({ name: "Battle (borrowed)", value: totals.borrowed });
      if (totals.sponsored > 0)
        items.push({ name: "Battle (sponsored)", value: totals.sponsored });
    }
    return items;
  }, [totals]);

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
                <div
                  key={k}
                  className="rounded-lg border bg-card/40 p-3 text-center"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {PERIOD_LABELS[k]}
                  </div>
                  <div className="mt-1 text-lg font-bold tabular-nums">
                    {formatNumber(stats.openings[k])}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    openings
                  </div>
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
                No daily data
              </p>
            ) : (
              <ChartContainer
                config={revenueConfig}
                className="h-[250px] w-full"
              >
                <BarChart data={filtered} accessibilityLayer>
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
                  <Legend verticalAlign="top" height={28} iconType="square" iconSize={10} />
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

        {/* Daily Openings stacked bar — all 4 categories */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Daily Openings
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!hasDaily ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No daily data
              </p>
            ) : (
              <ChartContainer
                config={openingsConfig}
                className="h-[250px] w-full"
              >
                <BarChart data={filtered} accessibilityLayer>
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
                  <Legend verticalAlign="top" height={28} iconType="square" iconSize={10} />
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
                    name="Battles"
                  />
                  <Bar
                    dataKey="borrowedOpenings"
                    stackId="flags"
                    fill="var(--color-borrowedOpenings)"
                    name="Borrowed"
                  />
                  <Bar
                    dataKey="sponsoredOpenings"
                    stackId="flags"
                    fill="var(--color-sponsoredOpenings)"
                    name="Sponsored"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pie chart — opening breakdown */}
      {totals.total > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Opening Breakdown ({formatNumber(totals.total)} total)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-8">
              <div className="h-[180px] w-[180px] shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                      stroke="none"
                    >
                      {pieData.map((_, i) => (
                        <Cell
                          key={i}
                          fill={PIE_COLORS[i % PIE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      itemStyle={tooltipItemStyle}
                      labelStyle={tooltipLabelStyle}
                      formatter={(value) => [formatNumber(Number(value)), ""]}
                      separator=""
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-1.5">
                {pieData.map((item, i) => {
                  const pct =
                    totals.total > 0
                      ? ((item.value / totals.total) * 100).toFixed(1)
                      : "0";
                  return (
                    <div
                      key={item.name}
                      className="flex items-center gap-3 text-sm"
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{
                          background: PIE_COLORS[i % PIE_COLORS.length],
                        }}
                      />
                      <span className="flex-1">{item.name}</span>
                      <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">
                        {pct}%
                      </span>
                      <span className="w-12 text-right font-medium tabular-nums">
                        {formatNumber(item.value)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
