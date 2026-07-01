import Link from "next/link";
import { PieChart, ArrowDown, ArrowUp, Gift, Repeat } from "lucide-react";
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
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import { MetricTile } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import {
  getRevenueBreakdown,
  type RevenuePeriod,
} from "@/lib/queries/analytics-revenue";
import { compareRevenue } from "@/lib/clickhouse/compare/analytics-revenue";
import { RevenueStackedCharts } from "./revenue-chart";
import type { AnalyticsPeriod } from "./types";

/**
 * Revenue-by-source breakdown — rendered from the canonical
 * `@/lib/metrics` payload (`getRevenueBreakdown`).
 *
 * Three category groups, each a table with amount + % contribution:
 *   • Inflows (house revenue) — wager + shipping fee. House gains → emerald.
 *   • Gaming payout (the payout side of GGR) — cards kept + battle refunds
 *     + upgrader payouts. User gets value back → rose.
 *   • Reward / marketing spend (the GGR→NGR gap) — bonuses, rakeback,
 *     affiliate, rain/race, etc. House gives → rose.
 *   • Neutral conversions — card / voucher ↔ balance moves of value the
 *     user already owns. Excluded from GGR/NGR → muted.
 *
 * GGR = inflow gaming revenue − gaming payout (gaming-only; card
 * conversions NEUTRAL; upgrader from `upgrader_games`, never the ledger).
 * NGR = GGR − reward spend − net rain. House-POV colors throughout.
 *
 * Stacked area charts below show how each category moves over time.
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

  // A failed revenue breakdown takes the whole tab to a panel fallback
  // (everything below depends on it). The withdrawn-coins card was removed
  // (money-out display hidden by owner request), so its scan no longer runs.
  const { data, error } = await safeQuery(
    () => getRevenueBreakdown(period),
    null,
    "analytics.revenue",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Revenue by source"
        hint="The revenue breakdown query failed — refresh to retry."
        size="panel"
      />
    );
  }

  // Comparison-mode ClickHouse twin (fire-and-forget). No-op unless the
  // `analytics_revenue` surface is in `comparison` mode. Diffs against the
  // served Postgres payload; never awaited, swallows its own errors, never
  // affects the rendered output.
  void compareRevenue(data);

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
              Ledger flow bucketed by category. Inflows are house revenue
              (wagers, fees); gaming payout is value returned on packs /
              battles / upgrader. GGR = inflow gaming revenue − gaming
              payout; NGR = GGR after reward spend. Card / voucher
              conversions are neutral (value the user already owns) and are
              excluded from both.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Total Inflow"
            value={formatCurrency(data.totalInflow)}
            icon={ArrowUp}
            accent="emerald"
            sub={`${data.inflows.length} revenue categories`}
          />
          <MetricTile
            label="Gaming Payout"
            value={formatCurrency(data.totalGamingPayout)}
            icon={ArrowDown}
            accent="rose"
            sub="Cards kept + refunds + upgrader"
          />
          <MetricTile
            label="GGR"
            value={formatCurrency(data.ggr)}
            icon={PieChart}
            accent={data.ggr >= 0 ? "emerald" : "rose"}
            sub="Wager − gaming payout"
          />
          <MetricTile
            label="NGR"
            value={formatCurrency(data.ngr)}
            icon={Gift}
            accent={data.ngr >= 0 ? "emerald" : "rose"}
            sub="GGR − reward spend"
          />
        </div>

        <div className="flex justify-end">
          <RevenuePeriodFilter current={period} />
        </div>

        {/* Breakdown tables — gaming revenue (inflow vs gaming payout),
            then reward spend, then neutral conversions. */}
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <ArrowUp className="size-4 text-emerald-500" />
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
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <ArrowDown className="size-4 text-rose-500" />
                Gaming payout (returned to users)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SourceTable
                rows={data.gamingOutflows}
                total={data.totalGamingPayout}
                accent="rose"
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Gift className="size-4 text-rose-500" />
                Reward &amp; marketing spend
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                House-funded giveaways — the gap between GGR and NGR.
              </p>
            </CardHeader>
            <CardContent>
              <SourceTable
                rows={data.rewardOutflows}
                total={data.totalRewardSpend}
                accent="rose"
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Repeat className="size-4 text-muted-foreground" />
                Neutral conversions
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Card / voucher ↔ balance moves of value the user already
                owns. Excluded from GGR and NGR.
              </p>
            </CardHeader>
            <CardContent>
              <SourceTable
                rows={data.neutral}
                total={data.totalNeutral}
                accent="neutral"
              />
            </CardContent>
          </Card>
        </div>

        {/* "Withdrawn coins" card removed — the money-out (crypto + physical
            withdrawal) breakdown is no longer surfaced (owner request). It fed
            only its own display card, never GGR/NGR/P&L, so those figures are
            unchanged. */}

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
    <div className="flex flex-wrap gap-1 rounded-md border bg-muted/40 p-0.5">
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
  accent: "emerald" | "rose" | "neutral";
}) {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const colorClass =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";
  const barClass =
    accent === "emerald"
      ? "bg-emerald-500/60"
      : accent === "rose"
        ? "bg-rose-500/60"
        : "bg-muted-foreground/40";

  return (
    <>
      {/* Mobile card list (<md) — label + amount headline, share % and a
          full-width bar underneath. House-POV accent preserved. */}
      <div className="space-y-2 md:hidden">
        {sorted.map((r) => {
          const pct = total > 0 ? (r.total / total) * 100 : 0;
          return (
            <div key={r.key} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {r.label}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-sm font-medium tabular-nums",
                    colorClass,
                  )}
                >
                  {formatCurrency(r.total)}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
                  <div
                    className={cn("h-full rounded-sm transition-all", barClass)}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {pct.toFixed(1)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop table (>=md) */}
      <div className="hidden md:block">
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
                        className={cn(
                          "h-full rounded-sm transition-all",
                          barClass,
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
