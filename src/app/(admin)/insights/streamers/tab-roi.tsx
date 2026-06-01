import Link from "next/link";
import { Percent, Coins, TrendingDown, TrendingUp } from "lucide-react";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { getStreamerInsightRows } from "@/lib/queries/insights-streamers/overview";
import { periodLabel, type StreamerPeriod } from "./types";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Affiliate ROI tab — house return on the money paid (or owed) to each
 * creator.
 *
 *   ROI = housePnl / commissionAccrued
 *
 * Per CLAUDE.md House-POV: positive ROI is emerald, negative rose. A
 * creator with no accrued commission has ROI = null and renders as
 * "—" (we paid them nothing, ROI is undefined).
 *
 * Sort: most-positive ROI first (best performers), then most-negative
 * (worst performers) at the bottom of the table. A separate "Bottom
 * Performers" section surfaces the rose tail so the operator can see
 * who's losing us money relative to what they cost.
 */
export async function RoiTab({ period }: { period: StreamerPeriod }) {
  const { data: all, error } = await safeQuery(
    () => getStreamerInsightRows(period),
    [] as Awaited<ReturnType<typeof getStreamerInsightRows>>,
    "insights-streamers.roi",
  );
  if (error) {
    return (
      <TileErrorFallback
        label="Streamers — Affiliate ROI"
        hint="The streamer insights query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  // Only consider creators with accrued commission in the window — ROI
  // is undefined when commission is 0, and listing them as ∞ ROI would
  // mislead the operator.
  const withCommission = all.filter((r) => r.commissionAccruedUsd > 0);

  // Sort by descending ROI so top performers float to the top. ROI is
  // never null in this filtered set (commissionAccrued > 0).
  const sortedByRoi = [...withCommission].sort(
    (a, b) => (b.houseRoi ?? 0) - (a.houseRoi ?? 0),
  );

  // KPI tiles: portfolio-wide ROI snapshot.
  const totalCommission = withCommission.reduce(
    (acc, r) => acc + r.commissionAccruedUsd,
    0,
  );
  const totalHousePnl = withCommission.reduce(
    (acc, r) => acc + r.housePnl,
    0,
  );
  const portfolioRoi =
    totalCommission > 0 ? totalHousePnl / totalCommission : null;
  const profitable = sortedByRoi.filter((r) => r.housePnl > 0).length;
  const unprofitable = sortedByRoi.filter((r) => r.housePnl < 0).length;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <KpiTile
            label="Portfolio ROI"
            value={
              portfolioRoi === null
                ? "—"
                : `${(portfolioRoi * 100).toFixed(1)}%`
            }
            sub="House P&L ÷ commission"
            icon={Percent}
            accent={
              portfolioRoi === null
                ? "blue"
                : portfolioRoi >= 0
                  ? "emerald"
                  : "rose"
            }
          />
          <KpiTile
            label="Total Commission"
            value={formatCurrency(totalCommission)}
            sub="Owed to creators in window"
            icon={Coins}
            accent="rose"
          />
          <KpiTile
            label="Profitable Creators"
            value={formatNumber(profitable)}
            sub="Net positive to house"
            icon={TrendingUp}
            accent="emerald"
          />
          <KpiTile
            label="Unprofitable"
            value={formatNumber(unprofitable)}
            sub="Cost more than they brought"
            icon={TrendingDown}
            accent="rose"
          />
        </div>
      </FadeIn>

      <FadeIn delay={75}>
        <SectionHeading
          icon={Percent}
          title={`ROI Ranking — ${periodLabel(period)}`}
        />
        <div className="surface-sheen surface-raise rounded-xl border bg-card mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-center">#</TableHead>
                <TableHead>Streamer</TableHead>
                <TableHead>Code</TableHead>
                <TableHead className="text-right">Commission</TableHead>
                <TableHead className="text-right">House P&L</TableHead>
                <TableHead className="text-right">ROI %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedByRoi.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No accrued commission in this window.
                  </TableCell>
                </TableRow>
              ) : (
                sortedByRoi.map((r, idx) => {
                  const pnlPos = r.housePnl >= 0;
                  const roiPct = (r.houseRoi ?? 0) * 100;
                  return (
                    <TableRow key={r.userId}>
                      <TableCell className="text-center text-muted-foreground tabular-nums">
                        {idx + 1}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/creators/${r.userId}`}
                          className="font-medium hover:underline"
                        >
                          {r.username ?? r.userId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {r.primaryCode ? (
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {r.primaryCode}
                          </code>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        −{formatCurrency(r.commissionAccruedUsd)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          pnlPos
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400",
                        )}
                      >
                        {pnlPos ? "+" : "−"}
                        {formatCurrency(Math.abs(r.housePnl))}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-semibold tabular-nums",
                          roiPct >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400",
                        )}
                      >
                        {roiPct >= 0 ? "+" : ""}
                        {roiPct.toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </FadeIn>
    </div>
  );
}
