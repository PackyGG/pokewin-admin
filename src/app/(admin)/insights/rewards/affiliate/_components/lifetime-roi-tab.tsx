import Link from "next/link";
import {
  CircleDollarSign,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
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
import { getAffiliateLifetimeRoi } from "@/lib/queries/insights-rewards/affiliate/lifetime-roi";

/**
 * Lifetime ROI per affiliate (period-agnostic). Sourced from the
 * `affiliate_accounts` denormalised counters.
 *
 * House-POV:
 *   - Commission paid is house cost → rose.
 *   - Downstream wager is house-positive (we take the rake) → emerald.
 *   - ROI proxy = wager - earned. Positive = emerald (program is
 *     net-positive for the house on this affiliate). Negative = rose.
 *
 * Note: ROI here uses lifetime wager not lifetime GGR (the platform
 * doesn't track per-affiliate GGR). Marginal GGR rate is ~2–4%, so
 * admins can apply that mental multiplier when scoring "is the wager
 * lift worth the commission cost".
 */
export async function AffiliateLifetimeRoiTab() {
  const { data, error } = await safeQuery(
    () => getAffiliateLifetimeRoi(),
    null,
    "insights-rewards-affiliate.lifetime-roi",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Lifetime ROI"
        hint="The lifetime-ROI query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={CircleDollarSign}
          title="No paid affiliates yet"
          description="No affiliate_accounts rows with lifetime payouts > 0."
          compact
        />
      </div>
    );
  }

  const totalPaid = data.reduce((a, r) => a + r.lifetimeCommissionPaid, 0);
  const totalAccrued = data.reduce((a, r) => a + r.lifetimeAccruedAvailable, 0);
  const totalEarned = data.reduce((a, r) => a + r.lifetimeEarnedGross, 0);
  const totalWager = data.reduce((a, r) => a + r.lifetimeDownstreamWager, 0);
  const totalReferred = data.reduce((a, r) => a + r.totalReferred, 0);
  const positiveCount = data.filter((r) => r.roiProxyUsd >= 0).length;
  const overallRoi = totalWager - totalEarned;
  const overallPositive = overallRoi >= 0;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Listed affiliates"
            value={formatNumber(data.length)}
            sub={`${formatNumber(positiveCount)} positive · ${formatNumber(totalReferred)} referred`}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Lifetime commission"
            value={formatCurrency(totalPaid)}
            sub={`+ ${formatCurrency(totalAccrued)} accrued`}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Lifetime wager"
            value={formatCurrency(totalWager)}
            sub="Cohort lifetime"
            icon={TrendingUp}
            accent="emerald"
          />
          <KpiTile
            label="ROI (wager − earned)"
            value={`${overallPositive ? "+" : "−"}${formatCurrency(Math.abs(overallRoi))}`}
            sub={overallPositive ? "House net-positive" : "House net-negative"}
            icon={overallPositive ? TrendingUp : TrendingDown}
            accent={overallPositive ? "emerald" : "rose"}
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={CircleDollarSign}
            title={`Lifetime ROI · top ${data.length} affiliates by commission paid`}
          />
          <p className="text-xs text-muted-foreground">
            Sourced from `affiliate_accounts` denormalised counters.
            ROI proxy compares lifetime cohort wager to lifetime
            commission earned (paid + accrued). Not GGR — apply ~2–4%
            mental multiplier for marginal house edge.
          </p>
          <div className="rounded-2xl border bg-card p-1.5 sm:p-2">
            <div className="space-y-1.5 md:hidden">
              {data.map((r) => (
                <div
                  key={r.affiliateUserId}
                  className="space-y-1.5 rounded-lg border bg-card px-3 py-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/users/${r.affiliateUserId}`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {r.username ?? r.affiliateUserId.slice(0, 8)}
                    </Link>
                    {r.roiProxyUsd >= 0 ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/30 text-[10px] text-emerald-600 dark:text-emerald-400"
                      >
                        +{formatCurrency(r.roiProxyUsd)}
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-rose-500/30 text-[10px] text-rose-600 dark:text-rose-400"
                      >
                        −{formatCurrency(Math.abs(r.roiProxyUsd))}
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
                    <div className="text-muted-foreground">
                      Referred: <span className="text-foreground">{formatNumber(r.totalReferred)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      Paid:{" "}
                      <span className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.lifetimeCommissionPaid)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Wager:{" "}
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.lifetimeDownstreamWager)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      % of wager:{" "}
                      <span className="text-foreground">
                        {r.commissionPctOfWager === null
                          ? "—"
                          : `${r.commissionPctOfWager.toFixed(2)}%`}
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
                    <TableHead className="text-right">Referred</TableHead>
                    <TableHead className="text-right">Lifetime paid</TableHead>
                    <TableHead className="text-right">Accrued</TableHead>
                    <TableHead className="text-right">Lifetime wager</TableHead>
                    <TableHead className="text-right">% of wager</TableHead>
                    <TableHead className="text-right">ROI</TableHead>
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
                        {formatNumber(r.totalReferred)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.lifetimeCommissionPaid)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(r.lifetimeAccruedAvailable)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.lifetimeDownstreamWager)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.commissionPctOfWager === null
                          ? "—"
                          : `${r.commissionPctOfWager.toFixed(2)}%`}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${
                          r.roiProxyUsd >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400"
                        }`}
                      >
                        {r.roiProxyUsd >= 0 ? "+" : "−"}
                        {formatCurrency(Math.abs(r.roiProxyUsd))}
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
