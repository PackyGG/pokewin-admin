import Link from "next/link";
import { PieChart, ArrowDown, ArrowUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils/format";
import { FadeIn } from "@/components/fade-in";
import { MetricTile } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import {
  getRevenueBreakdown,
  type RevenuePeriod,
} from "@/lib/queries/analytics-revenue";
import { RevenueStackedCharts } from "./revenue-chart";
import type { AnalyticsPeriod } from "./types";

/**
 * Revenue-by-source breakdown. Two tables — one for inflows (house
 * revenue: wagers, sponsorship, shipping fees), one for outflows (paid
 * to users: card sales, bonuses, rakeback, affiliate, rain, etc.). Each
 * row shows absolute amount + % contribution to its category.
 *
 * Stacked area charts below the tables show how each category's share
 * moves over time.
 */
export async function RevenueTab({
  period: heroPeriod,
}: {
  period: AnalyticsPeriod;
}) {
  const period: RevenuePeriod =
    heroPeriod === "today"
      ? "7d"
      : heroPeriod === "7d" ||
          heroPeriod === "30d" ||
          heroPeriod === "90d" ||
          heroPeriod === "all"
        ? heroPeriod
        : "30d";

  const data = await getRevenueBreakdown(period);

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <PieChart className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Revenue by source</h3>
            <p className="text-muted-foreground">
              Every dollar that flows through the ledger bucketed by
              category. Inflows are house revenue; outflows are money paid
              back to users. GGR is the delta — what we keep.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile
            label="Total Inflow"
            value={formatCurrency(data.totalInflow)}
            icon={ArrowUp}
            accent="emerald"
            sub={`${data.inflows.length} source categories`}
          />
          <MetricTile
            label="Total Outflow"
            value={formatCurrency(data.totalOutflow)}
            icon={ArrowDown}
            accent="rose"
            sub={`${data.outflows.length} sink categories`}
          />
          <MetricTile
            label="GGR (net)"
            value={formatCurrency(data.ggr)}
            icon={PieChart}
            accent={data.ggr >= 0 ? "emerald" : "rose"}
            sub="Inflow − Outflow"
          />
        </div>

        <div className="flex justify-end">
          <RevenuePeriodFilter current={period} />
        </div>

        {/* Breakdown tables */}
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Inflows (house revenue)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SourceTable
                rows={data.inflows}
                total={data.totalInflow}
                accent="emerald"
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Outflows (paid to users)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SourceTable
                rows={data.outflows}
                total={data.totalOutflow}
                accent="rose"
              />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Stacked revenue series — {periodLabel(period)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RevenueStackedCharts daily={data.daily} />
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}

function periodLabel(p: RevenuePeriod): string {
  switch (p) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "all":
      return "All time";
  }
}

function RevenuePeriodFilter({ current }: { current: RevenuePeriod }) {
  const periods: { value: RevenuePeriod; label: string }[] = [
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "90d", label: "90d" },
    { value: "all", label: "All" },
  ];
  return (
    <div className="flex gap-1 rounded-md border bg-muted/40 p-0.5">
      {periods.map(({ value, label }) => (
        <Link
          key={value}
          href={`?tab=revenue&period=${value}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-sm px-2 py-0.5 text-xs font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}

function SourceTable({
  rows,
  total,
  accent,
}: {
  rows: { key: string; label: string; total: number }[];
  total: number;
  accent: "emerald" | "rose";
}) {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const colorClass =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
  const barClass = accent === "emerald" ? "bg-emerald-500/60" : "bg-rose-500/60";

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead className="text-right">Share</TableHead>
          <TableHead className="w-[120px]">Bar</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((r) => {
          const pct = total > 0 ? (r.total / total) * 100 : 0;
          return (
            <TableRow key={r.key}>
              <TableCell className="font-medium">{r.label}</TableCell>
              <TableCell
                className={cn("text-right tabular-nums", colorClass)}
              >
                {formatCurrency(r.total)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {pct.toFixed(1)}%
              </TableCell>
              <TableCell>
                <div className="h-2 overflow-hidden rounded-sm bg-muted">
                  <div
                    className={cn("h-full rounded-sm transition-all", barClass)}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
