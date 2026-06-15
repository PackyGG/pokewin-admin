import Link from "next/link";
import { RotateCcw, Clock, TrendingDown, Sigma } from "lucide-react";
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
import { getAffiliateClaimCadence } from "@/lib/queries/insights-rewards/affiliate/claim-cadence";
import { compareAffiliateCadence } from "@/lib/clickhouse/compare/insights-affiliate-cadence";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Claim cadence per affiliate — how often the top 25 affiliates claim
 * their accrued commission within the active window. Surfaces the
 * three operational profiles:
 *
 *   - high-frequency claimers (small recurring claims)
 *   - bulk claimers (one large claim per period)
 *   - single-claim spikes (one isolated claim — dormant-then-active or
 *     cash-out, surfaces as `meanGapHours = null`)
 *
 * Median gap is robust to outliers; mean gap surfaces clustering. We
 * show both side-by-side.
 */
export async function AffiliateCadenceTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getAffiliateClaimCadence(period),
    null,
    "insights-rewards-affiliate.cadence",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Claim cadence"
        hint="The claim-cadence query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  void compareAffiliateCadence(period, data);

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={RotateCcw}
          title={`No affiliate claims in ${label.toLowerCase()}`}
          description="No affiliate_claim ledger rows in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const totalClaims = data.reduce((a, r) => a + r.claimCount, 0);
  const totalCommission = data.reduce((a, r) => a + r.totalCommission, 0);
  const singleClaim = data.filter((r) => r.claimCount === 1).length;
  const repeatClaimers = data.length - singleClaim;
  const repeatClaimerSubset = data.filter((r) => r.claimCount >= 2);
  const avgClaimsPerRepeat =
    repeatClaimerSubset.length > 0
      ? repeatClaimerSubset.reduce((a, r) => a + r.claimCount, 0) /
        repeatClaimerSubset.length
      : 0;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Top 25 claims"
            value={formatNumber(totalClaims)}
            sub={label}
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="Top 25 commission"
            value={formatCurrency(totalCommission)}
            sub="Sum across listed"
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Repeat claimers"
            value={`${formatNumber(repeatClaimers)} / ${formatNumber(data.length)}`}
            sub={`${avgClaimsPerRepeat.toFixed(1)} avg claims/repeat`}
            icon={RotateCcw}
            accent="blue"
          />
          <KpiTile
            label="Single-claim"
            value={formatNumber(singleClaim)}
            sub="One claim only"
            icon={Clock}
            accent="amber"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={RotateCcw}
            title={`Repeat-claim cadence · top ${data.length} · ${label}`}
          />
          <p className="text-xs text-muted-foreground">
            Mean / median gap between consecutive claims, in hours.
            Single-claim affiliates (count = 1) show {`"—"`} for gap.
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
                    <span className="rounded-md border bg-muted/30 px-1.5 py-0.5 text-[10px]">
                      {formatNumber(r.claimCount)} claims
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
                    <div className="text-muted-foreground">
                      Total:{" "}
                      <span className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.totalCommission)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Avg: <span className="text-foreground">{formatCurrency(r.meanClaimAmount)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      Med gap:{" "}
                      <span className="text-foreground">
                        {formatGap(r.medianGapHours)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Mean gap:{" "}
                      <span className="text-foreground">
                        {formatGap(r.meanGapHours)}
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
                    <TableHead className="text-right">Claims</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Mean amount</TableHead>
                    <TableHead className="text-right">Median amount</TableHead>
                    <TableHead className="text-right">Mean gap</TableHead>
                    <TableHead className="text-right">Median gap</TableHead>
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
                        {formatNumber(r.claimCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.totalCommission)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.meanClaimAmount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.medianClaimAmount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatGap(r.meanGapHours)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatGap(r.medianGapHours)}
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

function formatGap(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "—";
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins}m`;
  }
  if (hours < 48) {
    return `${hours.toFixed(1)}h`;
  }
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}
