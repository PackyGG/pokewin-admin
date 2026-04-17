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
  referrals: number;
  depositVolume: number;
  wagerVolume: number;
  commission: number;
  clicks: number;
};

const volumeConfig = {
  depositVolume: { label: "Deposits", color: "var(--color-chart-1)" },
  wagerVolume: { label: "Wagers", color: "var(--color-chart-2)" },
  commission: { label: "Commission", color: "var(--color-chart-3)" },
} satisfies ChartConfig;

const activityConfig = {
  referrals: { label: "Referrals", color: "var(--color-chart-4)" },
  clicks: { label: "Clicks", color: "var(--color-chart-5)" },
} satisfies ChartConfig;

const currencyFormatter = (v: number) => {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v}`;
};

export function CodeAnalyticsCharts({ data }: { data: DailyData[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Volume & Commission</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={volumeConfig} className="h-[300px] w-full">
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
              <Line type="monotone" dataKey="depositVolume" stroke="var(--color-depositVolume)" strokeWidth={2} dot={false} animationDuration={700} animationEasing="ease-out" />
              <Line type="monotone" dataKey="wagerVolume" stroke="var(--color-wagerVolume)" strokeWidth={2} dot={false} animationDuration={700} animationEasing="ease-out" />
              <Line type="monotone" dataKey="commission" stroke="var(--color-commission)" strokeWidth={2} dot={false} animationDuration={700} animationEasing="ease-out" />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Referrals & Clicks</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={activityConfig} className="h-[300px] w-full">
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
                width={50}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="referrals" fill="var(--color-referrals)" radius={[4, 4, 0, 0]} animationDuration={700} animationEasing="ease-out" />
              <Bar dataKey="clicks" fill="var(--color-clicks)" radius={[4, 4, 0, 0]} animationDuration={700} animationEasing="ease-out" />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}
