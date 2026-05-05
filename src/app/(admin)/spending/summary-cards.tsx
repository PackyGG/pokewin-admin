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
  Bar,
  BarChart,
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
  BarChart3,
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

  // Top-spending bar chart — same data, sorted descending so the
  // biggest expense category sits at the top of the horizontal bar
  // list. We compute share-of-total here so the right-side panel can
  // show "Salaries — $4,200 (38%)" beside each bar.
  const totalCategorySpend = summary.byCategory.reduce(
    (sum, item) => sum + item.amount,
    0,
  );
  const rankedCategories = summary.byCategory
    .slice()
    .sort((a, b) => b.amount - a.amount)
    .map((item) => ({
      category: getCategoryLabel(item.category),
      amount: item.amount,
      share: totalCategorySpend > 0 ? item.amount / totalCategorySpend : 0,
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
        <>
          {/* Top row: Top Spending Categories + Monthly Spending Trend
              side-by-side — the two charts an admin actually scans
              while planning next month's spend. Pie chart with the
              percentage breakdown moves below as supplementary detail. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-amber-500/[0.08] blur-2xl"
              />
              <div className="relative p-5">
                <SectionHeading
                  icon={BarChart3}
                  title="Top Spending Categories"
                />
                {rankedCategories.length > 0 ? (
                  <>
                    <ChartContainer
                      config={chartConfig}
                      className="aspect-auto h-[260px] w-full mt-3"
                    >
                      <BarChart
                        data={rankedCategories}
                        layout="vertical"
                        margin={{ left: 8, right: 24, top: 4, bottom: 4 }}
                      >
                        <CartesianGrid horizontal={false} />
                        <XAxis
                          type="number"
                          tickFormatter={(v) => `$${v}`}
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="category"
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                          width={108}
                        />
                        <ChartTooltip
                          cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                          content={
                            <ChartTooltipContent
                              formatter={(value) =>
                                formatCurrency(Number(value))
                              }
                              hideIndicator
                            />
                          }
                        />
                        <Bar
                          dataKey="amount"
                          radius={[0, 6, 6, 0]}
                          animationDuration={700}
                          animationEasing="ease-out"
                        >
                          {rankedCategories.map((entry, index) => (
                            <Cell key={index} fill={entry.fill} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ChartContainer>
                    {/* Compact summary list under the chart — gives
                        exact $ + share without needing to hover. */}
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      {rankedCategories.slice(0, 6).map((c) => (
                        <div
                          key={c.category}
                          className="flex items-center justify-between gap-2"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className="size-2 rounded-full shrink-0"
                              style={{ backgroundColor: c.fill }}
                            />
                            <span className="truncate text-muted-foreground">
                              {c.category}
                            </span>
                          </div>
                          <span className="tabular-nums font-medium shrink-0">
                            {formatCurrency(c.amount)}
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              ({(c.share * 100).toFixed(0)}%)
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="flex h-[260px] flex-col items-center justify-center text-center text-sm text-muted-foreground">
                    <BarChart3 className="size-8 text-muted-foreground/40 mb-2" />
                    <p>No expenses in this period.</p>
                    <p className="text-xs">Add expenses to see category breakdown.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Monthly trend — paired with the categories chart so
                admins see "what we spend on" + "how it changes over
                time" in one visual sweep. Empty state when there's
                only one month of data so the row stays balanced. */}
            <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-blue-500/[0.08] blur-2xl"
              />
              <div className="relative p-5">
                <SectionHeading icon={LineIcon} title="Monthly Spending Trend" />
                {trend.length > 0 ? (
                  <ChartContainer
                    config={{
                      total: { label: "Total", color: "hsl(220, 70%, 55%)" },
                    }}
                    className="aspect-auto h-[260px] w-full mt-3"
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
                ) : (
                  <div className="flex h-[260px] flex-col items-center justify-center text-center text-sm text-muted-foreground">
                    <LineIcon className="size-8 text-muted-foreground/40 mb-2" />
                    <p>Not enough history for a trend yet.</p>
                    <p className="text-xs">Logged expenses build the curve over months.</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Pie chart — supplementary percentage view, full-width row
              below the actionable charts. Renders only when there's
              category data to show. */}
          {chartData.length > 0 && (
            <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-purple-500/[0.08] blur-2xl"
              />
              <div className="relative p-5">
                <SectionHeading
                  icon={PieIcon}
                  title={`Percentage Breakdown — ${periodLabel}`}
                />
                <ChartContainer
                  config={chartConfig}
                  className="aspect-auto h-[260px] w-full mt-3"
                >
                  <PieChart>
                    <Pie
                      data={chartData}
                      dataKey="amount"
                      nameKey="category"
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={95}
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
        </>
      )}

    </div>
  );
}
