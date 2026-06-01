import {
  Wallet,
  Sparkles,
  UserMinus,
  TrendingUp,
  Sigma,
  Hash,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupFirstDeposit } from "@/lib/queries/insights-rewards/signup/first-deposit";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { CohortCompareCard } from "@/app/(admin)/rewards/analytics/_components/cohort-compare";

/**
 * First deposit cohort tab — claimers vs non-claimers FIRST-deposit
 * size comparison. Avg, median, total, plus a bucket distribution
 * chart so admins see the cohort shift across amount tiers.
 *
 * Reuses the existing `CohortCompareCard` from the rewards-analytics
 * signup tab so the lift card looks identical to the per-category
 * page — one component, two consumers.
 */
export async function FirstDepositTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getSignupFirstDeposit(period),
    null,
    "insights-rewards-signup.first-deposit",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Signup — First deposit"
        hint="The first-deposit query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  if (data.claimers.users === 0 && data.nonClaimers.users === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Wallet}
          title={`No first deposits in ${label.toLowerCase()}`}
          description="No cohort user deposited in this window."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiTile
            label="Claimer avg"
            value={formatCurrency(data.claimers.avg)}
            sub={`${formatNumber(data.claimers.users)} users`}
            icon={Sparkles}
            accent="rose"
          />
          <KpiTile
            label="Claimer median"
            value={formatCurrency(data.claimers.median)}
            sub="Typical first dep"
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="Non-claimer avg"
            value={formatCurrency(data.nonClaimers.avg)}
            sub={`${formatNumber(data.nonClaimers.users)} users`}
            icon={UserMinus}
            accent="blue"
          />
          <KpiTile
            label="Non-claimer median"
            value={formatCurrency(data.nonClaimers.median)}
            sub="Typical first dep"
            icon={Sigma}
            accent="blue"
          />
          <KpiTile
            label="Avg lift"
            value={
              data.liftPct === null
                ? "—"
                : `${data.liftPct >= 0 ? "+" : ""}${data.liftPct.toFixed(1)}%`
            }
            sub="Claimer over non"
            icon={TrendingUp}
            accent="blue"
          />
          <KpiTile
            label="Claimer total"
            value={formatCurrency(data.claimers.total)}
            sub={`Non total ${formatCurrency(data.nonClaimers.total)}`}
            icon={Hash}
            accent="rose"
          />
        </div>
      </FadeIn>

      {/* Cohort compare card — reused from the rewards-analytics signup
          tab so the lift card looks identical across the two pages. */}
      {data.claimers.users > 0 && data.nonClaimers.users > 0 && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading icon={Sparkles} title="Avg first-deposit size" />
            <CohortCompareCard
              title="Avg first-deposit size"
              subtitle="Bonus claimants vs non-claimants who deposited at least once"
              leftLabel="Claimers"
              leftValue={formatCurrency(data.claimers.avg)}
              leftSub={`${formatNumber(data.claimers.users)} users · median ${formatCurrency(data.claimers.median)}`}
              rightLabel="Non-claimers"
              rightValue={formatCurrency(data.nonClaimers.avg)}
              rightSub={`${formatNumber(data.nonClaimers.users)} users · median ${formatCurrency(data.nonClaimers.median)}`}
              liftPct={data.liftPct ?? 0}
            />
          </div>
        </FadeIn>
      )}

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Hash}
            title="First-deposit size buckets"
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              Distribution of cohort users&apos; first-deposit amount.
              Claimer cluster vs non-claimer cluster — see if the
              signup-bonus cohort skews into a higher amount tier.
            </p>
            <div className="mt-3 space-y-2">
              {data.buckets.map((b) => {
                const total = b.claimerCount + b.nonClaimerCount;
                const claimerShare = total > 0 ? (b.claimerCount / total) * 100 : 0;
                const nonShare = total > 0 ? (b.nonClaimerCount / total) * 100 : 0;
                return (
                  <div
                    key={b.label}
                    className="rounded-lg border bg-muted/20 p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {b.label}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {formatNumber(total)} users
                        </span>
                      </div>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatNumber(b.claimerCount)} claim · {formatNumber(b.nonClaimerCount)} non
                      </span>
                    </div>
                    <div className="mt-2 flex h-2 overflow-hidden rounded-sm bg-muted">
                      <div
                        className="h-full bg-rose-500/60 transition-all"
                        style={{ width: `${claimerShare}%` }}
                      />
                      <div
                        className="h-full bg-blue-500/60 transition-all"
                        style={{ width: `${nonShare}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-rose-500" />
                <span>Claimers</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-blue-500" />
                <span>Non-claimers</span>
              </span>
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
