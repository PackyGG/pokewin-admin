import { Clock, UserMinus, TrendingUp, Users } from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupTimeToClaim } from "@/lib/queries/insights-rewards/signup/time-to-claim";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { TimeToClaimHistogram } from "./time-to-claim-histogram";

/**
 * Time-to-claim tab — distribution of seconds/minutes/hours/days from
 * signup to first claim. Includes p25 / median / p75 / p95 +
 * cumulative-share callouts (1h / 1d / 7d / 30d).
 *
 * The histogram visualises non-uniform buckets (1m → 30d+) so the
 * "instant claim" cluster doesn't get smeared into the "within a day"
 * bucket. Volume bar is rose (house cost lens). Never-claimed cohort
 * size sits next to the histogram so admins read the drop-off head-on.
 */
export async function TimeToClaimTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data: ttc, error } = await safeQuery(
    () => getSignupTimeToClaim(period),
    null,
    "insights-rewards-signup.time-to-claim",
  );
  if (error || !ttc) {
    return (
      <TileErrorFallback
        label="Signup — Time-to-claim"
        hint="The time-to-claim query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  if (ttc.claimants === 0 && ttc.neverClaimed === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Clock}
          title={`No cohort in ${label.toLowerCase()}`}
          description="No signups + no claims in this window — try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <KpiTile
            label="Median"
            value={formatHours(ttc.medianHours)}
            sub={`p25 ${formatHours(ttc.p25Hours)} · p75 ${formatHours(ttc.p75Hours)}`}
            icon={Clock}
            accent="blue"
          />
          <KpiTile
            label="p95"
            value={formatHours(ttc.p95Hours)}
            sub="Slowest-95% claimant"
            icon={Clock}
            accent="blue"
          />
          <KpiTile
            label="Claimed in 1h"
            value={`${(ttc.shareWithin1h * 100).toFixed(1)}%`}
            sub="Of claimants"
            icon={TrendingUp}
            accent="blue"
          />
          <KpiTile
            label="Claimed in 24h"
            value={`${(ttc.shareWithin1d * 100).toFixed(1)}%`}
            sub="Of claimants"
            icon={TrendingUp}
            accent="blue"
          />
          <KpiTile
            label="Claimed in 7d"
            value={`${(ttc.shareWithin7d * 100).toFixed(1)}%`}
            sub="Of claimants"
            icon={TrendingUp}
            accent="blue"
          />
          <KpiTile
            label="Claimed in 30d"
            value={`${(ttc.shareWithin30d * 100).toFixed(1)}%`}
            sub="Of claimants"
            icon={TrendingUp}
            accent="blue"
          />
          <KpiTile
            label="Claimants"
            value={formatNumber(ttc.claimants)}
            sub={`In ${label.toLowerCase()}`}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Never claimed"
            value={formatNumber(ttc.neverClaimed)}
            sub="Cohort drop-off"
            icon={UserMinus}
            accent="rose"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Clock} title={`Time-to-claim histogram — ${label}`} />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              Distribution of hours from signup to FIRST{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                balance_reward_claim
              </code>{" "}
              per claimant. Bucket boundaries are non-uniform so the
              sub-minute cluster doesn&apos;t collapse into the &le;1h cell.
            </p>
            <div className="mt-3">
              <TimeToClaimHistogram buckets={ttc.buckets} />
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "—";
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins}m`;
  }
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}
