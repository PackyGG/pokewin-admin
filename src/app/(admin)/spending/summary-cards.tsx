"use client";

import {
  Pie,
  PieChart,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Area,
  AreaChart,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { SpendingSummary, MonthlyTrendItem } from "@/lib/queries/spending";
import { EXPENSE_CATEGORIES, CATEGORY_CHART_COLORS } from "./constants";
import {
  DollarSign,
  Receipt,
  Repeat,
  TrendingUp,
  PieChart as PieIcon,
  LineChart as LineIcon,
} from "lucide-react";
import { MetricTile, SectionHeading } from "@/components/modern-panels";

function getCategoryLabel(value: string) {
  return EXPENSE_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

function formatRange(from: string, to: string) {
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");
  // Same month? Show "March 2026"
  if (f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()) {
    return f.toLocaleString("en-US", { month: "long", year: "numeric" });
  }
  // Otherwise show range
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", { month: "short", day: "numeric" });
  return `${fmt(f)} – ${fmt(t)}, ${t.getFullYear()}`;
}

export function SummaryCards({
  summary,
  from,
  to,
  trend,
}: {
  summary: SpendingSummary;
  from: string;
  to: string;
  trend: MonthlyTrendItem[];
}) {
  const grandTotal = summary.totalPeriod + summary.recurringTotal;
  const prevTotal = summary.totalPrevPeriod + summary.recurringTotal;
  const change = prevTotal > 0 ? ((grandTotal - prevTotal) / prevTotal) * 100 : 0;

  const periodLabel = formatRange(from, to);

  const chartData = summary.byCategory.map((item) => ({
    category: getCategoryLabel(item.category),
    amount: item.amount,
    fill: CATEGORY_CHART_COLORS[item.category] ?? "hsl(0, 0%, 55%)",
  }));

  const chartConfig: ChartConfig = {};
  for (const item of summary.byCategory) {
    chartConfig[getCategoryLabel(item.category)] = {
      label: getCategoryLabel(item.category),
      color: CATEGORY_CHART_COLORS[item.category] ?? "hsl(0, 0%, 55%)",
    };
  }

  const changeAccent = change > 0 ? "rose" : change < 0 ? "emerald" : "blue";
  const changeLabel =
    change > 0
      ? `+${change.toFixed(1)}%`
      : change !== 0
        ? `${change.toFixed(1)}%`
        : "—";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label={`Total — ${periodLabel}`}
          value={formatCurrency(grandTotal)}
          icon={DollarSign}
          accent="blue"
        />
        <MetricTile
          label="One-Time Expenses"
          value={formatCurrency(summary.totalPeriod)}
          icon={Receipt}
          accent="amber"
        />
        <MetricTile
          label="Recurring Costs"
          value={formatCurrency(summary.recurringTotal)}
          icon={Repeat}
          accent="purple"
        />
        <div className={cn("rounded-xl border p-4", {
          "bg-rose-500/10 border-rose-500/20": changeAccent === "rose",
          "bg-emerald-500/10 border-emerald-500/20": changeAccent === "emerald",
          "bg-blue-500/10 border-blue-500/20": changeAccent === "blue",
        })}>
          <div className="flex items-center gap-2">
            <TrendingUp
              className={cn("size-4", {
                "text-rose-500": changeAccent === "rose",
                "text-emerald-500": changeAccent === "emerald",
                "text-blue-500": changeAccent === "blue",
              })}
            />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              vs Previous Period
            </span>
          </div>
          <p
            className={cn("mt-1 text-2xl font-bold tabular-nums", {
              "text-rose-600 dark:text-rose-400": changeAccent === "rose",
              "text-emerald-600 dark:text-emerald-400":
                changeAccent === "emerald",
              "text-blue-600 dark:text-blue-400": changeAccent === "blue",
            })}
          >
            {changeLabel}
          </p>
        </div>
      </div>

      {(chartData.length > 0 || trend.length > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {chartData.length > 0 && (
            <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-purple-500/[0.08] blur-2xl"
              />
              <div className="relative p-5">
                <SectionHeading
                  icon={PieIcon}
                  title={`Breakdown — ${periodLabel}`}
                />
                <ChartContainer
                  config={chartConfig}
                  className="aspect-auto h-[250px] w-full mt-3"
                >
                  <PieChart>
                    <Pie
                      data={chartData}
                      dataKey="amount"
                      nameKey="category"
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={2}
                      strokeWidth={0}
                      label={({ category, percent }) =>
                        `${category} ${(percent * 100).toFixed(0)}%`
                      }
                      labelLine={false}
                      fontSize={11}
                      animationDuration={700}
                      animationEasing="ease-out"
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={index} fill={entry.fill} />
                      ))}
                    </Pie>
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          formatter={(value) =>
                            formatCurrency(Number(value))
                          }
                          hideIndicator
                        />
                      }
                    />
                  </PieChart>
                </ChartContainer>
              </div>
            </div>
          )}

          {trend.length > 0 && (
            <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-blue-500/[0.08] blur-2xl"
              />
              <div className="relative p-5">
                <SectionHeading icon={LineIcon} title="Monthly Spending Trend" />
                <ChartContainer
                  config={{
                    total: { label: "Total", color: "hsl(220, 70%, 55%)" },
                  }}
                  className="aspect-auto h-[250px] w-full mt-3"
                >
                  <AreaChart data={trend} margin={{ left: 10, right: 10 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      fontSize={12}
                    />
                    <YAxis
                      tickFormatter={(v) => `$${v}`}
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          formatter={(value) =>
                            formatCurrency(Number(value))
                          }
                          hideIndicator
                        />
                      }
                    />
                    <defs>
                      <linearGradient
                        id="trendGradient"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor="hsl(220, 70%, 55%)"
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="100%"
                          stopColor="hsl(220, 70%, 55%)"
                          stopOpacity={0.05}
                        />
                      </linearGradient>
                    </defs>
                    <Area
                      type="monotone"
                      dataKey="total"
                      stroke="hsl(220, 70%, 55%)"
                      fill="url(#trendGradient)"
                      strokeWidth={2}
                      animationDuration={700}
                      animationEasing="ease-out"
                    />
                  </AreaChart>
                </ChartContainer>
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
