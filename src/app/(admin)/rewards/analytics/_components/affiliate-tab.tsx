import Link from "next/link";
import {
  Share2,
  Users,
  Sigma,
  TrendingUp,
  UserMinus,
  Crown,
} from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getAffiliateAnalytics } from "@/lib/queries/rewards-category-analytics";
import { getAffiliateExtras } from "@/lib/queries/rewards-category-extras";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";

/**
 * Affiliate tab on /rewards/analytics. Baseline + affiliate-account
 * lens + downstream-cohort lens + inactive-affiliate count.
 *
 * `affiliate_claim` ledger rows file under the AFFILIATE's user_id,
 * so the baseline's "Top 10 users by volume" already IS the top
 * affiliates by claim volume. To complement that view, this tab adds
 * a SECOND leaderboard sourced from `affiliate_code_usages`: top
 * affiliates by their DOWNSTREAM REFERRED USERS' wager volume in the
 * same window. That answers "which affiliate's cohort is generating
 * the most platform activity right now", distinct from "which
 * affiliate is claiming the most commission right now" (which can
 * skew toward dormant accounts pulling stored balance).
 *
 * KPI strip additions:
 *   - Distinct referred users contributing (count via
 *     affiliate_code_usages — referred_user_id distinct).
 *   - Inactive affiliates (affiliate_accounts with referrals but
 *     zero affiliate_claim ledger row in the window).
 *
 * PROPOSED (skipped this pass):
 *   - Affiliate lift (per-referred-cohort wager / GGR vs non-
 *     affiliate users). Needs an expensive sweep over the GGR
 *     definition restricted to referred user_ids, with a control
 *     bucket. Better as its own analysis page than a sidebar tile.
 *
 * House-POV: affiliate commissions are money the house GIVES users
 * (the affiliate) → rose.
 */
export async function AffiliateTab({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const [data, extras] = await Promise.all([
    getAffiliateAnalytics(period),
    getAffiliateExtras(period),
  ]);
  const base = baseDeepStatsTiles(data, periodLabel, {
    countSub: "Claims paid",
    avgPerUserSub: "avg per affiliate",
  });
  const extraTiles: DeepStatsTile[] = [
    {
      label: "Distinct affiliates",
      value: formatNumber(extras.distinctAffiliates),
      sub: "Paid in this window",
      icon: Users,
    },
    {
      label: "Avg per affiliate",
      value: formatCurrency(extras.avgPayoutPerAffiliate),
      sub: "Total / distinct affiliates",
      icon: Sigma,
    },
    {
      label: "Referred users active",
      value: formatNumber(extras.distinctReferredUsers),
      sub: "Distinct downstream users",
      icon: TrendingUp,
    },
    {
      label: "Inactive affiliates",
      value: formatNumber(extras.inactiveAffiliates),
      sub: "Had referrals · no claim in window",
      icon: UserMinus,
    },
  ];
  const tiles: DeepStatsTile[] = [...extraTiles, ...base];
  return (
    <div className="space-y-6">
      <CategoryDeepStatsPanel
        data={data}
        periodLabel={periodLabel}
        headerIcon={Share2}
        headerTitle="Affiliate"
        tiles={tiles}
        unitLabel="claims"
        emptyTitle="No affiliate claims in this window"
        emptyDescription={`No affiliates were paid in the ${periodLabel.toLowerCase()} period. Try a longer period.`}
      />

      {/* Top by referred-user wager — complements the baseline top-N
          by claim volume. Sourced from `affiliate_code_usages` so
          this is "whose cohort is wagering" not "who is claiming". */}
      {extras.topByReferredWager.length > 0 && (
        <div className="space-y-3">
          <SectionHeading
            icon={Crown}
            title="Top affiliates by referred-user wager"
          />
          <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              Distinct from the leaderboard above (which ranks by
              commission paid). This ranks by the wager their referred
              cohort generated in the window.
            </p>
            {/* Mobile cards */}
            <div className="mt-3 space-y-1.5 md:hidden">
              {extras.topByReferredWager.map((a, i) => (
                <div
                  key={a.affiliateUserId}
                  className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                >
                  <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
                    #{i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/users/${a.affiliateUserId}`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {a.username ?? a.affiliateUserId.slice(0, 8)}
                    </Link>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {formatNumber(a.referredCount)} referred
                    </span>
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(a.referredWagerUsd)}
                  </span>
                </div>
              ))}
            </div>
            {/* Desktop table */}
            <div className="mt-3 hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]">Rank</TableHead>
                    <TableHead>Affiliate</TableHead>
                    <TableHead className="text-right">Referred users</TableHead>
                    <TableHead className="text-right">Cohort wager</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {extras.topByReferredWager.map((a, i) => (
                    <TableRow key={a.affiliateUserId}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        #{i + 1}
                      </TableCell>
                      <TableCell className="font-medium">
                        <Link
                          href={`/users/${a.affiliateUserId}`}
                          className="hover:underline"
                        >
                          {a.username ?? a.affiliateUserId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNumber(a.referredCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(a.referredWagerUsd)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
