"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import { LineChart as LineChartIcon, BarChart3 } from "lucide-react";
import { formatCompactUsd } from "@/lib/utils/format";

/**
 * Creator Hub → Acquisition daily trend charts.
 *
 * Hub-styled recharts port of /creators/analytics/charts.tsx. House-POV
 * colors: wager + deposit volume = emerald (house income); commission =
 * rose (house cost); signups + clicks = blue (neutral funnel events).
 */

type DailyData = {
  date: string;
  signups: number;
  commission: number;
  wagerVolume: number;
  depositVolume: number;
  clicks: number;
};

const currencyFormatter = formatCompactUsd;

export function AcquisitionCharts({ data }: { data: DailyData[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">Volume &amp; Commission</span>
          <LineChartIcon className="size-4 text-emerald-500" />
        </div>
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 6, right: 4, left: 4, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="currentColor"
                className="text-border/50"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
                stroke="currentColor"
                className="text-muted-foreground"
                tickMargin={8}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
                stroke="currentColor"
                className="text-muted-foreground"
                width={56}
                tickMargin={8}
                tickFormatter={currencyFormatter}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  fontSize: 12,
                }}
                formatter={(value: number, name: string) => [
                  `$${Number(value).toFixed(2)}`,
                  name,
                ]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                type="monotone"
                dataKey="wagerVolume"
                name="Wager"
                stroke="#34d399"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Line
                type="monotone"
                dataKey="depositVolume"
                name="Deposits"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Line
                type="monotone"
                dataKey="commission"
                name="Commission"
                stroke="#fb7185"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">Signups &amp; Clicks</span>
          <BarChart3 className="size-4 text-blue-500" />
        </div>
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 6, right: 4, left: 4, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="currentColor"
                className="text-border/50"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
                stroke="currentColor"
                className="text-muted-foreground"
                tickMargin={8}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
                stroke="currentColor"
                className="text-muted-foreground"
                width={40}
                tickMargin={8}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar
                dataKey="signups"
                name="Signups"
                fill="#60a5fa"
                radius={[4, 4, 0, 0]}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Bar
                dataKey="clicks"
                name="Clicks"
                fill="#38bdf8"
                radius={[4, 4, 0, 0]}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
