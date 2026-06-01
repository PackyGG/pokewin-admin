import Link from "next/link";
import { Shuffle, Users, AlertTriangle, Sigma } from "lucide-react";
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
import { formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  AFFILIATE_CODE_SWITCH_MIN_COHORT,
  getAffiliateCodeSwitch,
} from "@/lib/queries/insights-rewards/affiliate/code-switch";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Code-switch correlation. For each first-affiliate (the affiliate
 * the referred user FIRST used a code from), we measure how often the
 * cohort eventually moved on to other codes.
 *
 * Two switch metrics:
 *   - "switched away" = latest code != first code (cohort migrated)
 *   - "multi-code"    = used ≥2 distinct codes lifetime (cohort
 *                       experimented with bonuses, regardless of
 *                       final landing code)
 *
 * Cohort must be ≥5 users to be ranked (see constant) so a 1-user
 * affiliate with 100% switching share doesn't outrank larger cohorts
 * by noise.
 *
 * Highest switch-away share floats to the top — the affiliates whose
 * cohort behaves most like bonus-snipers.
 */
export async function AffiliateCodeSwitchTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getAffiliateCodeSwitch(period),
    null,
    "insights-rewards-affiliate.code-switch",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Code-switch"
        hint="The code-switch query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Shuffle}
          title={`No cohorts ≥ ${AFFILIATE_CODE_SWITCH_MIN_COHORT} users in ${label.toLowerCase()}`}
          description={`Code-switch ranking requires cohort size ≥ ${AFFILIATE_CODE_SWITCH_MIN_COHORT} for statistical sanity. Try a longer period.`}
          compact
        />
      </div>
    );
  }

  const totalCohort = data.reduce((a, r) => a + r.cohortSize, 0);
  const totalSwitched = data.reduce((a, r) => a + r.switchersAway, 0);
  const totalMultiCode = data.reduce((a, r) => a + r.switchersAny, 0);
  const overallSwitchShare = totalCohort > 0 ? totalSwitched / totalCohort : 0;
  const overallMultiShare = totalCohort > 0 ? totalMultiCode / totalCohort : 0;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Listed affiliates"
            value={formatNumber(data.length)}
            sub={`Cohort ≥ ${AFFILIATE_CODE_SWITCH_MIN_COHORT}`}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Cohort users"
            value={formatNumber(totalCohort)}
            sub="Distinct referred · listed"
            icon={Sigma}
            accent="blue"
          />
          <KpiTile
            label="Switched away"
            value={`${(overallSwitchShare * 100).toFixed(1)}%`}
            sub={`${formatNumber(totalSwitched)} of ${formatNumber(totalCohort)}`}
            icon={AlertTriangle}
            accent="amber"
          />
          <KpiTile
            label="Multi-code"
            value={`${(overallMultiShare * 100).toFixed(1)}%`}
            sub={`${formatNumber(totalMultiCode)} of ${formatNumber(totalCohort)}`}
            icon={Shuffle}
            accent="amber"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Shuffle}
            title={`Code-switch correlation · top ${data.length} affiliates · ${label}`}
          />
          <p className="text-xs text-muted-foreground">
            Sorted by share of cohort whose LATEST code differs from
            their FIRST code (the affiliate&apos;s own). Signals
            bonus-sniper churn in the cohort, or poor onboarding
            stickiness.
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
                    <span className="rounded-md border bg-amber-500/10 border-amber-500/30 px-1.5 py-0.5 text-[10px] tabular-nums text-amber-600 dark:text-amber-400">
                      {(r.switchAwayShare * 100).toFixed(1)}% away
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
                    <div className="text-muted-foreground">
                      Cohort: <span className="text-foreground">{formatNumber(r.cohortSize)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      Multi-code:{" "}
                      <span className="text-foreground">
                        {(r.multiCodeShare * 100).toFixed(1)}%
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
                    <TableHead className="text-right">Cohort</TableHead>
                    <TableHead className="text-right">Switched away</TableHead>
                    <TableHead className="text-right">% away</TableHead>
                    <TableHead className="text-right">Multi-code</TableHead>
                    <TableHead className="text-right">% multi</TableHead>
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
                        {formatNumber(r.cohortSize)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.switchersAway)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-amber-600 dark:text-amber-400">
                        {(r.switchAwayShare * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.switchersAny)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {(r.multiCodeShare * 100).toFixed(1)}%
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
