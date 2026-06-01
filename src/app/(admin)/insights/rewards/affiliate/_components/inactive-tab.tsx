import Link from "next/link";
import { UserMinus, Users, TrendingDown, Clock } from "lucide-react";
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
import { formatCurrency, formatNumber, formatRelative } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getInactiveAffiliates } from "@/lib/queries/insights-rewards/affiliate/inactive";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Inactive affiliates — accounts with lifetime referrals but ZERO
 * affiliate_claim rows in the window. Two sub-categories:
 *
 *   - "Active cohort, no claim" — had downstream usage in window but
 *     didn't claim. Affiliate is earning but not settling stored
 *     balance, OR the referred cohort didn't hit the payout threshold.
 *
 *   - "Dormant" — no downstream usage in window either. The genuine
 *     cold-storage cohort.
 *
 * Ordered by lifetime payout DESC so the highest-value-dormant float
 * to the top — these are the affiliates worth a re-activation push.
 */
export async function AffiliateInactiveTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getInactiveAffiliates(period),
    null,
    "insights-rewards-affiliate.inactive",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Inactive"
        hint="The inactive-affiliates query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={UserMinus}
          title="No inactive affiliates with referrals"
          description="Every affiliate account with lifetime referrals also claimed in this window. (Or the platform has no affiliate accounts yet.)"
          compact
        />
      </div>
    );
  }

  const totalLifetimePayout = data.reduce(
    (a, r) => a + r.totalPaidOutLifetime,
    0,
  );
  const totalWindowWager = data.reduce(
    (a, r) => a + r.windowDownstreamWager,
    0,
  );
  const dormant = data.filter((r) => !r.hasWindowUsage).length;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Listed affiliates"
            value={formatNumber(data.length)}
            sub="Top 25 by lifetime payout"
            icon={UserMinus}
            accent="amber"
          />
          <KpiTile
            label="Dormant"
            value={formatNumber(dormant)}
            sub="No window usage either"
            icon={Clock}
            accent="rose"
          />
          <KpiTile
            label="Lifetime payout"
            value={formatCurrency(totalLifetimePayout)}
            sub="Across listed accounts"
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Window wager"
            value={formatCurrency(totalWindowWager)}
            sub={`Earning, not claiming · ${label}`}
            icon={Users}
            accent="emerald"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={UserMinus}
            title={`Inactive affiliates · ${label}`}
          />
          <p className="text-xs text-muted-foreground">
            Affiliate accounts with lifetime referrals but zero
            affiliate_claim ledger rows in the window. Highest-lifetime-
            payout accounts surface first — the re-activation targets.
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
                    {r.hasWindowUsage ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/30 text-[10px] text-emerald-600 dark:text-emerald-400"
                      >
                        Earning
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-rose-500/30 text-[10px] text-rose-600 dark:text-rose-400"
                      >
                        Dormant
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
                    <div className="text-muted-foreground">
                      Referred: <span className="text-foreground">{formatNumber(r.totalReferred)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      Lifetime paid:{" "}
                      <span className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.totalPaidOutLifetime)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Window wager:{" "}
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.windowDownstreamWager)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Last claim:{" "}
                      <span className="text-foreground">
                        {r.lastClaimAt ? formatRelative(r.lastClaimAt) : "—"}
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
                    <TableHead className="text-right">Window wager</TableHead>
                    <TableHead>Last claim</TableHead>
                    <TableHead>Last usage</TableHead>
                    <TableHead>Status</TableHead>
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
                        {formatCurrency(r.totalPaidOutLifetime)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.windowDownstreamWager)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.lastClaimAt ? formatRelative(r.lastClaimAt) : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.lastUsageAt ? formatRelative(r.lastUsageAt) : "—"}
                      </TableCell>
                      <TableCell>
                        {r.hasWindowUsage ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/30 text-[10px] text-emerald-600 dark:text-emerald-400"
                          >
                            Earning · not claiming
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-rose-500/30 text-[10px] text-rose-600 dark:text-rose-400"
                          >
                            Dormant
                          </Badge>
                        )}
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
