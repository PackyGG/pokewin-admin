import Link from "next/link";
import { Crown, TrendingDown, Users, Sigma } from "lucide-react";
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
import { getTopAffiliatesByCommission } from "@/lib/queries/insights-rewards/affiliate/leaderboards";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Top 25 affiliates by commission EARNED in the active window. Sourced
 * from `ledger_transactions` (affiliate_claim rows filed under the
 * affiliate user_id).
 *
 * This lens skews toward affiliates settling stored balance — high
 * commission can coincide with low current activity. Pair with the
 * "Top by wager" tab for the activity lens.
 *
 * House-POV: commission is house cost → rose throughout.
 */
export async function AffiliateTopCommissionTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getTopAffiliatesByCommission(period),
    null,
    "insights-rewards-affiliate.top-commission",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Top by claim"
        hint="The top-by-commission query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Crown}
          title={`No paid affiliates in ${label.toLowerCase()}`}
          description="No affiliate_claim ledger rows in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const totalCommission = data.reduce((a, r) => a + r.commissionPaid, 0);
  const totalClaims = data.reduce((a, r) => a + r.claimCount, 0);
  const topRow = data[0];

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Top 25 commission"
            value={formatCurrency(totalCommission)}
            sub={label}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Top 25 claims"
            value={formatNumber(totalClaims)}
            sub="Across listed affiliates"
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="Avg per affiliate"
            value={formatCurrency(data.length > 0 ? totalCommission / data.length : 0)}
            sub={`Among top ${data.length}`}
            icon={Users}
            accent="rose"
          />
          <KpiTile
            label="#1 affiliate"
            value={
              topRow
                ? topRow.username ?? topRow.affiliateUserId.slice(0, 8)
                : "—"
            }
            sub={topRow ? formatCurrency(topRow.commissionPaid) : "—"}
            icon={Crown}
            accent="amber"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Crown}
            title={`Top ${data.length} affiliates by commission earned · ${label}`}
          />
          <div className="rounded-2xl border bg-card p-1.5 sm:p-2">
            {/* Mobile cards */}
            <div className="space-y-1.5 md:hidden">
              {data.map((r, i) => (
                <div
                  key={r.affiliateUserId}
                  className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                >
                  <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
                    #{i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/users/${r.affiliateUserId}`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {r.username ?? r.affiliateUserId.slice(0, 8)}
                    </Link>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {formatNumber(r.claimCount)} claims ·{" "}
                      {formatNumber(r.referredUsersInWindow)} referred
                    </span>
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(r.commissionPaid)}
                  </span>
                </div>
              ))}
            </div>
            {/* Desktop table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px]">Rank</TableHead>
                    <TableHead>Affiliate</TableHead>
                    <TableHead className="text-right">Claims</TableHead>
                    <TableHead className="text-right">Referred (window)</TableHead>
                    <TableHead className="text-right">Commission paid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((r, i) => (
                    <TableRow key={r.affiliateUserId}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        #{i + 1}
                      </TableCell>
                      <TableCell className="font-medium">
                        <Link
                          href={`/users/${r.affiliateUserId}`}
                          className="hover:underline"
                        >
                          {r.username ?? r.affiliateUserId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNumber(r.claimCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNumber(r.referredUsersInWindow)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.commissionPaid)}
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
