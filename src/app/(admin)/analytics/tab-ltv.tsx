import Link from "next/link";
import { TrendingUp, CircleCheck, CircleAlert, CircleX } from "lucide-react";
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
  getCreatorLtv,
  type LtvPeriod,
} from "@/lib/queries/analytics-ltv";
import { compareCreatorLtv } from "@/lib/clickhouse/compare/analytics-ltv";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getCreatorLtvFromClickHouse } from "@/lib/clickhouse/queries/analytics/ltv";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import type { AnalyticsPeriod } from "./types";

/**
 * Creator true LTV: for every creator in the admin, show how much
 * profit their referred users generate for the platform minus the
 * creator's own cost to us (commission, tips, balance fills). Net ROI
 * sorted desc — profitable creators float to the top, money-losers sink
 * to the bottom.
 */
export async function LtvTab({
  period: heroPeriod,
}: {
  period: AnalyticsPeriod;
}) {
  const ltvPeriod: LtvPeriod =
    heroPeriod === "today"
      ? "7d"
      : heroPeriod === "7d" ||
          heroPeriod === "30d" ||
          heroPeriod === "90d" ||
          heroPeriod === "all"
        ? heroPeriod
        : "30d";

  const { data, error } = await safeQuery(
    () =>
      resolveAdminRead<Awaited<ReturnType<typeof getCreatorLtv>>>(
        "analytics_ltv",
        {
          pg: () => getCreatorLtv(ltvPeriod),
          ch: async () =>
            getCreatorLtvFromClickHouse(ltvPeriod, await getExcludedUserIds()),
        },
      ),
    null,
    "analytics.ltv",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Creator true LTV"
        hint="The creator LTV query failed — refresh to retry."
        size="panel"
      />
    );
  }
  // Fire-and-forget ClickHouse comparison (no-op unless the `analytics_ltv`
  // surface is in comparison mode). Never affects the served Postgres payload.
  void compareCreatorLtv(ltvPeriod, data);

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <TrendingUp className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Creator true LTV</h3>
            <p className="text-muted-foreground">
              Gross platform P&amp;L from each creator&apos;s referred users
              minus what we&apos;ve paid the creator (commissions + tips +
              balance fills). Net ROI sorted desc — profitable creators at
              top. ROI multiple &gt; 1 means every dollar we paid them came
              back as &gt;$1 of platform profit.
            </p>
          </div>
        </div>

        {/* Totals */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Gross Platform P&L"
            value={formatCurrency(data.totals.grossPlatformPnl)}
            icon={TrendingUp}
            accent="emerald"
            sub="From all referred users, period-bounded"
          />
          <MetricTile
            label="Creator Cost"
            value={formatCurrency(data.totals.creatorCost)}
            icon={TrendingUp}
            accent="rose"
            sub="Commissions + tips + fills"
          />
          <MetricTile
            label="Net ROI"
            value={formatCurrency(data.totals.netRoi)}
            icon={TrendingUp}
            accent={data.totals.netRoi >= 0 ? "emerald" : "rose"}
            sub="Gross P&L − creator cost"
          />
          <MetricTile
            label="Profitable / Losing"
            value={`${data.totals.profitableCreators} / ${data.totals.losingCreators}`}
            icon={CircleCheck}
            accent="blue"
            sub={`${data.rows.length} creators total`}
          />
        </div>

        <Card>
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-sm font-medium">
              Creator LTV ranking — {periodLabel(ltvPeriod)}
            </CardTitle>
            <LtvPeriodFilter current={ltvPeriod} />
          </CardHeader>
          <CardContent>
            <LtvTable rows={data.rows} />
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}

function periodLabel(p: LtvPeriod): string {
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

function LtvPeriodFilter({ current }: { current: LtvPeriod }) {
  const periods: { value: LtvPeriod; label: string }[] = [
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
          href={`?tab=ltv&period=${value}`}
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

function LtvTable({ rows }: { rows: Awaited<ReturnType<typeof getCreatorLtv>>["rows"] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No creator data"
        description="No creators have referred activity in the selected window. Try a longer period."
        compact
      />
    );
  }

  return (
    <>
      {/* Mobile card list (<md) — the 7-column table is unreadable on a
          phone, so each creator becomes a tappable card: name + net ROI
          headline, the rest as meta rows. House-POV colors preserved. */}
      <div className="space-y-2 md:hidden">
        {rows.map((r) => {
          const pnlClass =
            r.grossPlatformPnl > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : r.grossPlatformPnl < 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground";
          const roiClass =
            r.netRoi > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : r.netRoi < 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground";
          return (
            <div
              key={r.userId}
              className="rounded-lg border bg-card p-3 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/users/${r.userId}`}
                  className="min-w-0 flex-1 hover:underline"
                >
                  <span className="block truncate text-sm font-medium">
                    {r.username ?? "—"}
                  </span>
                  {r.code && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {r.code}
                    </span>
                  )}
                </Link>
                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      roiClass,
                    )}
                  >
                    {formatCurrency(r.netRoi)}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Net ROI
                  </div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Referred</span>
                  <span className="tabular-nums">
                    {formatNumber(r.referredUsers)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">ROI ×</span>
                  <span className="tabular-nums">
                    {r.roiMultiple === null
                      ? "—"
                      : `${r.roiMultiple.toFixed(2)}x`}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Gross P&amp;L</span>
                  <span className={cn("tabular-nums", pnlClass)}>
                    {formatCurrency(r.grossPlatformPnl)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Cost</span>
                  <span className="tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(r.creatorCost)}
                  </span>
                </div>
              </div>
              <div className="mt-2">
                <StatusBadge netRoi={r.netRoi} creatorCost={r.creatorCost} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop table (>=md) */}
      <div className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader>
          <TableRow>
            <TableHead>Creator</TableHead>
            <TableHead className="text-right">Referred</TableHead>
            <TableHead className="text-right">Gross P&amp;L</TableHead>
            <TableHead className="text-right">Creator Cost</TableHead>
            <TableHead className="text-right">Net ROI</TableHead>
            <TableHead className="text-right">ROI Multiple</TableHead>
            <TableHead className="text-center">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.userId}>
              <TableCell className="font-medium">
                <Link
                  href={`/users/${r.userId}`}
                  className="hover:underline"
                >
                  {r.username ?? "—"}
                </Link>
                {r.code && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {r.code}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(r.referredUsers)}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right tabular-nums",
                  r.grossPlatformPnl > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : r.grossPlatformPnl < 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                )}
              >
                {formatCurrency(r.grossPlatformPnl)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(r.creatorCost)}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right tabular-nums font-semibold",
                  r.netRoi > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : r.netRoi < 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                )}
              >
                {formatCurrency(r.netRoi)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.roiMultiple === null
                  ? "—"
                  : `${r.roiMultiple.toFixed(2)}x`}
              </TableCell>
              <TableCell className="text-center">
                <StatusBadge netRoi={r.netRoi} creatorCost={r.creatorCost} />
              </TableCell>
            </TableRow>
          ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function StatusBadge({
  netRoi,
  creatorCost,
}: {
  netRoi: number;
  creatorCost: number;
}) {
  // Profitable: netRoi > 0. Losing: negative by > 20% of creator cost.
  // Break-even: in between, or no creator cost yet.
  if (creatorCost === 0 && netRoi === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
        — idle
      </span>
    );
  }
  if (netRoi > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
        <CircleCheck className="size-3" />
        Profitable
      </span>
    );
  }
  if (creatorCost > 0 && Math.abs(netRoi) > creatorCost * 0.2) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs text-rose-600 dark:text-rose-400 border border-rose-500/30">
        <CircleX className="size-3" />
        Losing
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400 border border-amber-500/30">
      <CircleAlert className="size-3" />
      Break-even
    </span>
  );
}
