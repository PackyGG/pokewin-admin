"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

type RevenuePoint = { date: string; daily: number; cumulative: number };

const RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 0 },
];

const chartConfig = {
  daily: { label: "Daily Revenue", color: "#3b82f6" },
  cumulative: { label: "Cumulative Revenue", color: "#22c55e" },
} satisfies ChartConfig;

export function PackRevenueChart({ data }: { data: RevenuePoint[] }) {
  const [range, setRange] = useState(30);
  const [mode, setMode] = useState<"cumulative" | "daily">("cumulative");

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Revenue History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">No revenue data yet</p>
        </CardContent>
      </Card>
    );
  }

  const filtered = range > 0
    ? (() => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - range);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        return data.filter((d) => d.date >= cutoffStr);
      })()
    : data;

  const chartData = filtered.length > 0 ? filtered : data;
  const tickInterval = Math.max(1, Math.floor(chartData.length / 10));
  const dataKey = mode === "cumulative" ? "cumulative" : "daily";

  const formatValue = (v: number) => {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
    return `$${v.toFixed(0)}`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Revenue History</CardTitle>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant={mode === "cumulative" ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setMode("cumulative")}
            >
              Cumulative
            </Button>
            <Button
              variant={mode === "daily" ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setMode("daily")}
            >
              Daily
            </Button>
          </div>
          <div className="h-4 w-px bg-border" />
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
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <AreaChart data={chartData} accessibilityLayer>
            <defs>
              <linearGradient id="revCumulativeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="revDailyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              interval={tickInterval}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              domain={[0, "auto"]}
              tickFormatter={formatValue}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={mode === "cumulative" ? "#22c55e" : "#3b82f6"}
              strokeWidth={2}
              fill={mode === "cumulative" ? "url(#revCumulativeGrad)" : "url(#revDailyGrad)"}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
