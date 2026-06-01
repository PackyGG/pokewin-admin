import Link from "next/link";
import { Trophy, TrendingUp, Users, Sigma } from "lucide-react";
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
import { getTopAffiliatesByWager } from "@/lib/queries/insights-rewards/affiliate/leaderboards";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Top 25 affiliates by DOWNSTREAM WAGER in the active window. Different
 * lens from "Top by claim" — sourced from `affiliate_code_usages` where
 * each row carries the `wager_amount_usd` for the play that hit through
 * the affiliate code.
 *
 * Surfaces affiliates whose referred cohort is generating the most
 * platform activity right now, regardless of when they're claiming.
 * Pair with the cadence tab if you want to see how often they then claim.
 *
 * Wager is house-positive (we take the rake from it) → emerald.
 * Commission paid is house-cost → rose.
 */
export async function AffiliateTopWagerTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getTopAffiliatesByWager(period),
    null,
    "insights-rewards-affiliate.top-wager",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Top by wager"
        hint="The top-by-wager query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title={`No downstream wager in ${label.toLowerCase()}`}
          description="No referred users wagered through any affiliate code in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const totalWager = data.reduce((a, r) => a + r.referredWager, 0);
  const totalCommission = data.reduce((a, r) => a + r.commissionPaid, 0);
  const totalReferred = data.reduce((a, r) => a + r.referredCount, 0);
  const topRow = data[0];

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Top 25 wager"
            value={formatCurrency(totalWager)}
            sub={label}
            icon={TrendingUp}
            accent="emerald"
          />
          <KpiTile
            label="Top 25 commission"
            value={formatCurrency(totalCommission)}
            sub="Paid to these affiliates"
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="Referred users"
            value={formatNumber(totalReferred)}
            sub="Across listed affiliates"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="#1 affiliate"
            value={
              topRow
                ? topRow.username ?? topRow.affiliateUserId.slice(0, 8)
                : "—"
            }
            sub={topRow ? formatCurrency(topRow.referredWager) : "—"}
            icon={Trophy}
            accent="amber"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Trophy}
            title={`Top ${data.length} affiliates by downstream wager · ${label}`}
          />
          <div className="rounded-2xl border bg-card p-1.5 sm:p-2">
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
                      {formatNumber(r.referredCount)} referred ·{" "}
                      {formatCurrency(r.commissionPaid)} paid
                    </span>
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(r.referredWager)}
                  </span>
                </div>
              ))}
            </div>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px]">Rank</TableHead>
                    <TableHead>Affiliate</TableHead>
                    <TableHead className="text-right">Referred users</TableHead>
                    <TableHead className="text-right">Commission paid</TableHead>
                    <TableHead className="text-right">Cohort wager</TableHead>
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
                        {formatNumber(r.referredCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.commissionPaid)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.referredWager)}
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
