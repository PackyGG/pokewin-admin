import Link from "next/link";
import {
  Coins,
  Users,
  TrendingUp,
  TrendingDown,
  Trophy,
  Eye,
} from "lucide-react";
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
import { formatCompactUsd, formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { getStreamerInsightRows } from "@/lib/queries/insights-streamers/overview";
import { periodLabel, type StreamerPeriod } from "./types";

/**
 * Overview tab — every creator ranked by NET REVENUE TO HOUSE.
 *
 * Formula (House-POV):
 *   housePnl = cohortDeposits − cohortCardWithdrawals − commissionAccrued
 *
 * Positive → emerald (we kept value from this creator's cohort).
 * Negative → rose (they cost us money: card withdrawals + commission
 * outpaced the deposits the cohort brought in during the window).
 *
 * KPI strip totals the same numbers across all creators so the operator
 * can see the streamer programme's net contribution at a glance.
 */
export async function OverviewTab({ period }: { period: StreamerPeriod }) {
  const rows = await getStreamerInsightRows(period);

  // Aggregates for the headline KPI strip — sums across the whole
  // creator population in this window. Same math as the per-row figure.
  const totalCreators = rows.length;
  const activeCreators = rows.filter(
    (r) => r.cohortWagerUsd > 0 || r.cohortDepositsUsd > 0,
  ).length;
  const totalHousePnl = rows.reduce((acc, r) => acc + r.housePnl, 0);
  const totalCommission = rows.reduce(
    (acc, r) => acc + r.commissionAccruedUsd,
    0,
  );
  const totalCohortWager = rows.reduce(
    (acc, r) => acc + r.cohortWagerUsd,
    0,
  );

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <KpiTile
            label="Creators"
            value={formatNumber(totalCreators)}
            sub={`${activeCreators} active in ${periodLabel(period).toLowerCase()}`}
            icon={Users}
            accent="blue"
          />
          {/* House P&L — emerald when positive (we kept value), rose
              when negative (cohort took more out than they put in). */}
          <KpiTile
            label="House P&L"
            value={formatCompactUsd(totalHousePnl)}
            sub="Deposits − card WD − commission"
            icon={totalHousePnl >= 0 ? TrendingUp : TrendingDown}
            accent={totalHousePnl >= 0 ? "emerald" : "rose"}
          />
          {/* Commission accrued — money owed to creators. From the
              house perspective every dollar of accrued commission is a
              liability we will eventually pay out, so it gets the
              "user-winning" rose tint. */}
          <KpiTile
            label="Commission Accrued"
            value={formatCompactUsd(totalCommission)}
            sub="What creators have earned"
            icon={Coins}
            accent="rose"
          />
          {/* Cohort wager — money users WAGERED through these codes.
              Emerald = revenue-producing volume from the house POV. */}
          <KpiTile
            label="Cohort Wager"
            value={formatCompactUsd(totalCohortWager)}
            sub="Total volume from referred users"
            icon={Trophy}
            accent="emerald"
          />
        </div>
      </FadeIn>

      <FadeIn delay={75}>
        <SectionHeading
          icon={Trophy}
          title={`All Streamers — ${periodLabel(period)}`}
        />
        <div className="surface-sheen surface-raise rounded-xl border bg-card mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Streamer</TableHead>
                <TableHead>Code</TableHead>
                <TableHead className="text-right">Referred</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Cohort Wager</TableHead>
                <TableHead className="text-right">Cohort Deposits</TableHead>
                <TableHead className="text-right">Card WD</TableHead>
                <TableHead className="text-right">Commission</TableHead>
                <TableHead className="text-right">House P&L</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No creators with activity in this window.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => {
                  const pnlPos = r.housePnl >= 0;
                  return (
                    <TableRow key={r.userId}>
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
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.referredCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.activeReferredCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/* Wager = volume coming IN from users. From the
                            house POV that's emerald (we're booking it). */}
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {formatCurrency(r.cohortWagerUsd)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/* Deposits = money flowing INTO the house from
                            this cohort. Emerald, same as wager. */}
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {formatCurrency(r.cohortDepositsUsd)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/* Card withdrawals = users taking value out. From
                            the house POV that's rose. */}
                        <span className="text-rose-600 dark:text-rose-400">
                          {r.cohortCardWithdrawalsUsd > 0
                            ? `−${formatCurrency(r.cohortCardWithdrawalsUsd)}`
                            : formatCurrency(0)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/* Commission owed to the creator = liability →
                            rose. */}
                        <span className="text-rose-600 dark:text-rose-400">
                          {r.commissionAccruedUsd > 0
                            ? `−${formatCurrency(r.commissionAccruedUsd)}`
                            : formatCurrency(0)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        <span
                          className={cn(
                            pnlPos
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-rose-600 dark:text-rose-400",
                          )}
                        >
                          {pnlPos ? "+" : "−"}
                          {formatCurrency(Math.abs(r.housePnl))}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/creators/${r.userId}`}
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                          title="Open creator detail"
                        >
                          <Eye className="size-3.5" />
                        </Link>
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
