import {
  UserPlus,
  Clock,
  TrendingUp,
  UserMinus,
  Users,
  PieChart,
  Filter,
  Globe2,
  Sparkles,
  TrendingDown,
} from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getSignupAnalytics } from "@/lib/queries/rewards-category-analytics";
import { getSignupExtras } from "@/lib/queries/rewards-category-extras";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";
import { CohortCompareCard } from "./cohort-compare";
import { DistributionBarChart } from "./distribution-bar-chart";

/**
 * Sign Up tab on /rewards/analytics.
 *
 * Source: `balance_reward_claim` ledger rows. The platform has no
 * dedicated `signup_bonus` ledger type — all signup-pack / welcome
 * claims land in this generic reward-claim row (see schema enum
 * `ledger_transaction_type`). Cohort denominator = users who signed
 * up inside the period (`user.created_at` filter).
 *
 * Layers above the baseline + cohort lens KPIs:
 *
 *   1. Conversion funnel — signups → claimed → first deposit → repeat
 *      deposit. Each stage is a subset of the previous so the bars
 *      narrow as drop-off compounds.
 *   2. Cohort compare card — avg first-deposit USD for claimants vs
 *      non-claimants in the signup cohort. Tells us if the bonus
 *      actually attracts deeper-pocketed users.
 *   3. Retention — share of claimants who made a 2nd deposit within
 *      7d / 30d of their first.
 *   4. Signup source distribution — auth providerId breakdown.
 *   5. Country distribution of claiming cohort (top 6 + other).
 *   6. Hour-of-day distribution of claim events (24-bin UTC).
 *
 * House-POV: signup reward claims are money the house GIVES users
 * → rose.
 */
export async function SignupTab({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const [data, extras] = await Promise.all([
    getSignupAnalytics(period),
    getSignupExtras(period),
  ]);
  const base = baseDeepStatsTiles(data, periodLabel, {
    countSub: "Reward claims",
  });
  // Cohort lens tiles sit at the front so admins read engagement
  // before raw payouts. Funnel callouts (retention) are surfaced
  // below the strip via their own sections — too many tiles in one
  // strip becomes a wall.
  const extraTiles: DeepStatsTile[] = [
    {
      label: "Cohort signups",
      value: formatNumber(extras.cohortSignups),
      sub: `${formatNumber(extras.newClaimants)} claimed`,
      icon: Users,
    },
    {
      label: "Median time-to-claim",
      value: formatHours(extras.medianHoursToClaim),
      sub: "From signup",
      icon: Clock,
    },
    {
      label: "Claimed in 24h",
      value: `${(extras.shareClaimWithin24h * 100).toFixed(1)}%`,
      sub: "Of claiming cohort",
      icon: TrendingUp,
    },
    {
      label: "Claimed in 7d",
      value: `${(extras.shareClaimWithin7d * 100).toFixed(1)}%`,
      sub: "Of claiming cohort",
      icon: TrendingUp,
    },
    {
      label: "Drop-off",
      value: `${(extras.dropOffShare * 100).toFixed(1)}%`,
      sub: "Signed up, never claimed",
      icon: UserMinus,
    },
    {
      label: "2nd deposit in 7d",
      value: `${(extras.retention.shareSecondDepositWithin7d * 100).toFixed(1)}%`,
      sub: "Of claimants w/ first deposit",
      icon: TrendingUp,
    },
    {
      label: "2nd deposit in 30d",
      value: `${(extras.retention.shareSecondDepositWithin30d * 100).toFixed(1)}%`,
      sub: "Of claimants w/ first deposit",
      icon: TrendingUp,
    },
  ];
  const tiles: DeepStatsTile[] = [...extraTiles, ...base];
  return (
    <div className="space-y-6">
      <CategoryDeepStatsPanel
        data={data}
        periodLabel={periodLabel}
        headerIcon={UserPlus}
        headerTitle="Sign Up"
        tiles={tiles}
        unitLabel="claims"
        emptyTitle="No signup reward claims in this window"
        emptyDescription={`No signup / balance reward claims were filed in the ${periodLabel.toLowerCase()} period. Try a longer period.`}
      />

      {/* Conversion funnel — signups → claimed → first deposit → repeat */}
      {extras.cohortSignups > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={Filter} title="Acquisition funnel" />
          <FunnelPanel funnel={extras.funnel} />
        </div>
      )}

      {/* First-deposit cohort compare — claimants vs non-claimants. */}
      {extras.firstDepositCohort.claimantsCount > 0 &&
        extras.firstDepositCohort.nonClaimantsCount > 0 && (
          <div className="space-y-3">
            <SectionHeading icon={Sparkles} title="First deposit by cohort" />
            <CohortCompareCard
              title="Avg first-deposit size"
              subtitle="Bonus claimants vs non-claimants who deposited at least once"
              leftLabel="Claimants"
              leftValue={formatCurrency(extras.firstDepositCohort.claimantsAvg)}
              leftSub={`${formatNumber(extras.firstDepositCohort.claimantsCount)} users`}
              rightLabel="Non-claimants"
              rightValue={formatCurrency(extras.firstDepositCohort.nonClaimantsAvg)}
              rightSub={`${formatNumber(extras.firstDepositCohort.nonClaimantsCount)} users`}
              liftPct={extras.firstDepositCohort.liftPct}
            />
          </div>
        )}

      {/* Signup source distribution */}
      {extras.signupSources.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={PieChart} title="Signup source distribution" />
          <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              Auth provider breakdown for the signup cohort.
            </p>
            <div className="mt-3 space-y-2">
              {extras.signupSources.map((s) => (
                <div
                  key={s.provider}
                  className="rounded-lg border bg-muted/20 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium capitalize">
                        {s.provider}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatNumber(s.count)} signups
                      </span>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular-nums">
                      {s.share.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
                      <div
                        className="h-full rounded-sm bg-rose-500/60 transition-all"
                        style={{ width: `${s.share}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Country distribution + hour-of-day side-by-side */}
      {extras.countryDistribution.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <SectionHeading
              icon={Globe2}
              title="Country distribution of claimants"
            />
            <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <div className="space-y-1.5">
                {extras.countryDistribution.map((c) => (
                  <div
                    key={c.code}
                    className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2"
                  >
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {c.code}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
                      <div
                        className="h-full rounded-sm bg-rose-500/60 transition-all"
                        style={{ width: `${c.share}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-xs font-medium tabular-nums">
                      {formatNumber(c.count)}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {c.share.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <SectionHeading icon={Clock} title="Claim hour-of-day (UTC)" />
            <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <p className="text-[11px] text-muted-foreground">
                When this cohort claims their signup bonus.
              </p>
              <div className="mt-3">
                <DistributionBarChart
                  data={extras.hourOfDayBuckets}
                  metric="count"
                  height={180}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Funnel panel — four-stage horizontal bars from signups → claimed →
 * first deposit → repeat deposit. Each bar's width is a % of the
 * `signups` denominator so the visual drop-off compounds left-to-
 * right (matches the acquisition funnel on /creators/[userId]).
 *
 * House-POV: every stage row carries a rose subline — drop-off is
 * not coloured (drop-off is a NEUTRAL fact, not a house cost or win),
 * so the bars stay rose-tinted to keep the page family-consistent.
 */
function FunnelPanel({
  funnel,
}: {
  funnel: {
    signups: number;
    claimed: number;
    firstDeposit: number;
    repeatDeposit: number;
  };
}) {
  const stages = [
    { label: "Signups", icon: UserPlus, count: funnel.signups },
    { label: "Claimed bonus", icon: Sparkles, count: funnel.claimed },
    { label: "First deposit", icon: TrendingUp, count: funnel.firstDeposit },
    {
      label: "Repeat deposit",
      icon: TrendingDown,
      count: funnel.repeatDeposit,
    },
  ];
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
      <p className="text-[11px] text-muted-foreground">
        Drop-off from signup through repeat deposit. Each bar is % of
        the signup cohort.
      </p>
      <div className="mt-3 space-y-2">
        {stages.map((s, i) => {
          const Icon = s.icon;
          const share = funnel.signups > 0 ? (s.count / funnel.signups) * 100 : 0;
          const dropFromPrev =
            i > 0 && stages[i - 1].count > 0
              ? ((stages[i - 1].count - s.count) / stages[i - 1].count) * 100
              : 0;
          return (
            <div key={s.label} className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className="size-4 shrink-0 text-rose-500" />
                  <span className="truncate text-sm font-medium">
                    {s.label}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatNumber(s.count)} users
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {i > 0 && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      −{dropFromPrev.toFixed(1)}% vs prev
                    </span>
                  )}
                  <span className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                    {share.toFixed(1)}%
                  </span>
                </div>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-sm bg-muted">
                <div
                  className="h-full rounded-sm bg-rose-500/60 transition-all"
                  style={{ width: `${share}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Pretty-print an hours-since duration. Sub-hour → minutes, sub-day
 * → hours, then days. Defensive against NaN / negative values which
 * would imply clock skew in the cohort sweep.
 */
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
