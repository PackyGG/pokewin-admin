import Link from "next/link";
import { PieChart, ArrowDown, ArrowUp, Coins, Gift, Repeat } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import { MetricTile } from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import {
  getRevenueBreakdown,
  type RevenuePeriod,
} from "@/lib/queries/analytics-revenue";
import {
  getWithdrawnCoinsBreakdown,
  type WithdrawnAsset,
} from "@/lib/queries/analytics-withdrawals";
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

  // Each leg degrades independently: a failed revenue breakdown takes
  // the whole tab to a panel fallback (everything below depends on it);
  // a failed withdrawn-coins scan only degrades its own card.
  const [{ data, error }, withdrawnCoinsResult] = await Promise.all([
    safeQuery(() => getRevenueBreakdown(period), null, "analytics.revenue"),
    safeQuery(
      () => getWithdrawnCoinsBreakdown(period),
      null,
      "analytics.revenue.withdrawnCoins",
    ),
  ]);
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Revenue by source"
        hint="The revenue breakdown query failed — refresh to retry."
        size="panel"
      />
    );
  }
  const withdrawnCoins = withdrawnCoinsResult.data;

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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Coins className="size-4 text-primary" />
              Withdrawn coins — {periodLabel(period)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {withdrawnCoinsResult.error || !withdrawnCoins ? (
              <TileErrorFallback
                label="Withdrawn coins"
                hint="The withdrawal breakdown query failed — other sections still rendered. Refresh to retry."
                size="panel"
              />
            ) : (
              <WithdrawnCoinsTable
                assets={withdrawnCoins.assets}
                totalCryptoUsd={withdrawnCoins.totalCryptoUsd}
                physicalUsd={withdrawnCoins.physicalUsd}
                physicalCount={withdrawnCoins.physicalCount}
              />
            )}
          </CardContent>
        </Card>

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

/**
 * Crypto-asset withdrawal breakdown. Each row = one crypto asset
 * sorted by USD value descending. The footer line shows physical
 * (shipped card) totals so admins can compare crypto-cashout volume
 * against physical-card volume in the same window.
 *
 * House POV: every row here is real cash leaving the platform, so
 * dollar amounts render in rose. Native crypto amount is rendered
 * neutral (it's a quantity, not a P&L impact).
 */
function WithdrawnCoinsTable({
  assets,
  totalCryptoUsd,
  physicalUsd,
  physicalCount,
}: {
  assets: WithdrawnAsset[];
  totalCryptoUsd: number;
  physicalUsd: number;
  physicalCount: number;
}) {
  if (assets.length === 0 && physicalCount === 0) {
    return (
      <EmptyState
        icon={Coins}
        title="No withdrawals in this window"
        description="No crypto cash-outs or physical card shipments in the selected period. Try a longer period."
        compact
      />
    );
  }
  return (
    <div className="space-y-3">
      {assets.length === 0 ? (
        <EmptyState
          icon={Coins}
          title="No crypto withdrawals in this window"
          compact
        />
      ) : (
        <>
          {/* Mobile card list (<md) — asset + USD headline (rose, real
              cash leaving), count/native/share as meta + a bar. */}
          <div className="space-y-2 md:hidden">
            {assets.map((a) => {
              const pct =
                totalCryptoUsd > 0 ? (a.totalUsd / totalCryptoUsd) * 100 : 0;
              return (
                <div key={a.asset} className="rounded-lg border bg-card p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs font-medium">
                      {a.asset}
                    </span>
                    <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(a.totalUsd)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="tabular-nums">
                      {formatNumber(a.count)} withdrawals
                    </span>
                    <span className="truncate font-mono tabular-nums">
                      {a.totalCryptoAmount.toLocaleString("en-US", {
                        maximumFractionDigits: 8,
                      })}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
                      <div
                        className="h-full rounded-sm bg-rose-500/60 transition-all"
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
                  <TableHead>Asset</TableHead>
                  <TableHead className="text-right">Withdrawals</TableHead>
                  <TableHead className="text-right">Native amount</TableHead>
                  <TableHead className="text-right">USD value</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                  <TableHead className="w-[120px]">Bar</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((a) => {
                  const pct =
                    totalCryptoUsd > 0
                      ? (a.totalUsd / totalCryptoUsd) * 100
                      : 0;
                  return (
                    <TableRow key={a.asset}>
                      <TableCell className="font-mono text-xs">
                        {a.asset}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(a.count)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {a.totalCryptoAmount.toLocaleString("en-US", {
                          maximumFractionDigits: 8,
                        })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(a.totalUsd)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {pct.toFixed(1)}%
                      </TableCell>
                      <TableCell>
                        <div className="h-2 overflow-hidden rounded-sm bg-muted">
                          <div
                            className="h-full rounded-sm bg-rose-500/60 transition-all"
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
      )}

      {/* Physical card shipments — separate line so the crypto table
          stays focused on coins. Physical withdrawals don't have a
          coin to attribute to but they're still real outflows of the
          same shape, so we surface them here for completeness. */}
      <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Physical card shipments</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            {formatNumber(physicalCount)}
          </span>
        </div>
        <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
          {physicalCount > 0 ? formatCurrency(physicalUsd) : "—"}
        </span>
      </div>
    </div>
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
