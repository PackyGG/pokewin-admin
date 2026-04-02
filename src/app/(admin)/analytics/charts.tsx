"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

type DailyData = {
  date: string;
  ggr: number;
  ngr: number;
  packWager: number;
  battleWager: number;
  uniqueVisitors: number;
  newSignups: number;
};

const revenueConfig = {
  ggr: { label: "GGR", color: "var(--color-chart-1)" },
  ngr: { label: "NGR", color: "var(--color-chart-2)" },
} satisfies ChartConfig;

const wagersConfig = {
  packWager: { label: "Pack Wagers", color: "var(--color-chart-3)" },
  battleWager: { label: "Battle Wagers", color: "var(--color-chart-4)" },
} satisfies ChartConfig;

const usersConfig = {
  uniqueVisitors: { label: "Unique Visitors", color: "var(--color-chart-1)" },
  newSignups: { label: "New Signups", color: "var(--color-chart-5)" },
} satisfies ChartConfig;

const currencyFormatter = (v: number) => {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v}`;
};

export function AnalyticsCharts({ data }: { data: DailyData[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Revenue Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Revenue (GGR & NGR)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={revenueConfig} className="h-[300px] w-full">
            <LineChart data={data} accessibilityLayer>
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
                width={70}
                tickFormatter={currencyFormatter}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => `$${Number(value).toFixed(2)}`}
                  />
                }
              />
              <Line
                type="monotone"
                dataKey="ggr"
                stroke="var(--color-ggr)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="ngr"
                stroke="var(--color-ngr)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* Wagers Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Wagers (Pack & Battle)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={wagersConfig} className="h-[300px] w-full">
            <BarChart data={data} accessibilityLayer>
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
                width={70}
                tickFormatter={currencyFormatter}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => `$${Number(value).toFixed(2)}`}
                  />
                }
              />
              <Bar
                dataKey="packWager"
                fill="var(--color-packWager)"
                stackId="wagers"
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="battleWager"
                fill="var(--color-battleWager)"
                stackId="wagers"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* Users Chart */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Users (Visitors & Signups)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={usersConfig} className="h-[300px] w-full">
            <LineChart data={data} accessibilityLayer>
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
                width={50}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line
                type="monotone"
                dataKey="uniqueVisitors"
                stroke="var(--color-uniqueVisitors)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="newSignups"
                stroke="var(--color-newSignups)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}
