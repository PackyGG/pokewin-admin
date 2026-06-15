import Link from "next/link";
import { Users, TrendingUp, Sigma, Percent } from "lucide-react";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
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
import { getAffiliateCohort } from "@/lib/queries/insights-rewards/affiliate/cohort";
import { compareAffiliateCohort } from "@/lib/clickhouse/compare/insights-affiliate-cohort";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Referred-user cohort tab. For the top 15 affiliates by downstream
 * wager in the active window we surface per-cohort metrics:
 *
 *   - Referred users active in window
 *   - Avg wager per referred user
 *   - Depositors (≥1 deposit)
 *   - Repeat depositors (≥2 deposits)
 *   - Deposit conversion (depositors / active)
 *   - Repeat conversion (repeat / active)
 *   - Avg first-deposit USD
 *
 * Pure cohort breakdown — no lift comparison against non-affiliate
 * users (see PROPOSED in the page note).
 */
export async function AffiliateCohortTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getAffiliateCohort(period),
    null,
    "insights-rewards-affiliate.cohort",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Cohort"
        hint="The cohort query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  void compareAffiliateCohort(period, data);

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Users}
          title={`No active cohorts in ${label.toLowerCase()}`}
          description="No top affiliates with downstream wager > 0. Try a longer period."
          compact
        />
      </div>
    );
  }

  const totalActive = data.reduce((a, r) => a + r.referredActive, 0);
  const totalDepositors = data.reduce((a, r) => a + r.depositors, 0);
  const totalRepeat = data.reduce((a, r) => a + r.repeatDepositors, 0);
  const overallDepositConv =
    totalActive > 0 ? totalDepositors / totalActive : 0;
  const overallRepeatConv = totalActive > 0 ? totalRepeat / totalActive : 0;
  const totalWager = data.reduce((a, r) => a + r.cohortWager, 0);
  const avgWagerOverall = totalActive > 0 ? totalWager / totalActive : 0;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Cohort users (top 15)"
            value={formatNumber(totalActive)}
            sub="Distinct referred · in window"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Cohort wager"
            value={formatCurrency(totalWager)}
            sub={label}
            icon={TrendingUp}
            accent="emerald"
          />
          <KpiTile
            label="Deposit conversion"
            value={`${(overallDepositConv * 100).toFixed(1)}%`}
            sub={`${formatNumber(totalDepositors)} / ${formatNumber(totalActive)}`}
            icon={Percent}
            accent="emerald"
          />
          <KpiTile
            label="Repeat conversion"
            value={`${(overallRepeatConv * 100).toFixed(1)}%`}
            sub={`${formatNumber(totalRepeat)} / ${formatNumber(totalActive)}`}
            icon={Sigma}
            accent="emerald"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Users}
            title={`Per-affiliate cohort · top ${data.length} · ${label}`}
          />
          <p className="text-xs text-muted-foreground">
            Overall avg wager per referred user: {formatCurrency(avgWagerOverall)}.
            Deposit conversion is lifetime (deposits since signup, not
            window-only).
          </p>
          <div className="rounded-2xl border bg-card p-1.5 sm:p-2">
            <div className="space-y-1.5 md:hidden">
              {data.map((r) => (
                <div
                  key={r.affiliateUserId}
                  className="space-y-1.5 rounded-lg border bg-card px-3 py-2.5"
                >
                  <Link
                    href={`/users/${r.affiliateUserId}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {r.username ?? r.affiliateUserId.slice(0, 8)}
                  </Link>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
                    <div className="text-muted-foreground">
                      Active: <span className="text-foreground">{formatNumber(r.referredActive)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      Wager:{" "}
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.cohortWager)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Dep conv: <span className="text-foreground">{(r.depositConversion * 100).toFixed(0)}%</span>
                    </div>
                    <div className="text-muted-foreground">
                      Repeat: <span className="text-foreground">{(r.repeatConversion * 100).toFixed(0)}%</span>
                    </div>
                    <div className="text-muted-foreground">
                      Avg 1st dep: <span className="text-foreground">{formatCurrency(r.avgFirstDepositUsd)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      Avg / user:{" "}
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.avgWagerPerReferred)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Affiliate</TableHead>
                    <TableHead className="text-right">Active</TableHead>
                    <TableHead className="text-right">Cohort wager</TableHead>
                    <TableHead className="text-right">Avg / user</TableHead>
                    <TableHead className="text-right">Depositors</TableHead>
                    <TableHead className="text-right">Repeat</TableHead>
                    <TableHead className="text-right">Avg 1st deposit</TableHead>
                    <TableHead className="text-right">Dep %</TableHead>
                    <TableHead className="text-right">Repeat %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((r) => (
                    <TableRow key={r.affiliateUserId}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/users/${r.affiliateUserId}`}
                          className="hover:underline"
                        >
                          {r.username ?? r.affiliateUserId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.referredActive)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.cohortWager)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.avgWagerPerReferred)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.depositors)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.repeatDepositors)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.avgFirstDepositUsd)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(r.depositConversion * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(r.repeatConversion * 100).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
