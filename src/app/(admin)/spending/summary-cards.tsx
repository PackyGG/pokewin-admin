"use client";

import { Pie, PieChart, Cell, XAxis, YAxis, CartesianGrid, Area, AreaChart } from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatCurrency } from "@/lib/utils/format";
import type { SpendingSummary, MonthlyTrendItem } from "@/lib/queries/spending";
import { EXPENSE_CATEGORIES, CATEGORY_CHART_COLORS } from "./constants";

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
  const fmt = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric" });
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
  const change = prevTotal > 0
    ? ((grandTotal - prevTotal) / prevTotal) * 100
    : 0;

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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-stat-label font-normal">
              Total — {periodLabel}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-stat-value tabular-nums">{formatCurrency(grandTotal)}</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-stat-label font-normal">
              One-Time Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-stat-value tabular-nums">{formatCurrency(summary.totalPeriod)}</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-stat-label font-normal">
              Recurring Costs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-stat-value tabular-nums">{formatCurrency(summary.recurringTotal)}</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-stat-label font-normal">
              vs Previous Period
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-stat-value tabular-nums ${change > 0 ? "text-destructive" : change < 0 ? "text-green-600 dark:text-green-400" : ""}`}>
              {change > 0 ? "+" : ""}
              {change !== 0 ? `${change.toFixed(1)}%` : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {chartData.length > 0 && (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Breakdown by Category — {periodLabel}</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
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
                        formatter={(value) => formatCurrency(Number(value))}
                        hideIndicator
                      />
                    }
                  />
                </PieChart>
              </ChartContainer>
            </CardContent>
          </Card>
        )}

        {trend.length > 0 && (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Monthly Spending Trend</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{ total: { label: "Total", color: "hsl(220, 70%, 55%)" } }}
                className="aspect-auto h-[200px] w-full"
              >
                <AreaChart data={trend} margin={{ left: 10, right: 10 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                  <YAxis tickFormatter={(v) => `$${v}`} fontSize={12} tickLine={false} axisLine={false} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) => formatCurrency(Number(value))}
                        hideIndicator
                      />
                    }
                  />
                  <defs>
                    <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(220, 70%, 55%)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="hsl(220, 70%, 55%)" stopOpacity={0.05} />
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
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
