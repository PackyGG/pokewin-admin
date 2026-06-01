import {
  UserPlus,
  Sparkles,
  TrendingDown,
  Percent,
  Clock,
  Wallet,
  Hash,
  LineChart as LineChartIcon,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupOverview } from "@/lib/queries/insights-rewards/signup/overview";
import { getSignupDaily } from "@/lib/queries/insights-rewards/signup/daily";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { SignupDailyChart } from "./signup-area-chart";

/**
 * Overview tab — top-line numbers + daily series for
 * /insights/rewards/signup.
 *
 * Headline KPI strip:
 *   - Signups (window)
 *   - Signup-bonus claimants
 *   - Claim conversion %
 *   - Total signup-bonus cost (rose, house cost)
 *   - Avg per claim
 *   - Median time-to-claim (hours)
 *   - First depositors (distinct cohort users with ≥1 deposit)
 *   - First-deposit conversion %
 *
 * House-POV:
 *   - signups → neutral (acquisition) → blue
 *   - bonus payouts → house cost → rose
 *   - conversion ratios → neutral → blue
 */
export async function OverviewTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const [overviewRes, dailyRes] = await Promise.all([
    safeQuery(
      () => getSignupOverview(period),
      null,
      "insights-rewards-signup.overview",
    ),
    safeQuery(
      () => getSignupDaily(period),
      null,
      "insights-rewards-signup.overview-daily",
    ),
  ]);
  if (
    overviewRes.error ||
    !overviewRes.data ||
    dailyRes.error ||
    !dailyRes.data
  ) {
    return (
      <TileErrorFallback
        label="Signup — Overview"
        hint="The overview query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const overview = overviewRes.data;
  const daily = dailyRes.data;
  const label = insightsRewardsPeriodLabel(period);

  if (overview.signups === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={UserPlus}
          title={`No signups in ${label.toLowerCase()}`}
          description="No users signed up in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-8">
          <KpiTile
            label="Signups (window)"
            value={formatNumber(overview.signups)}
            sub={formatDeltaSub(overview.priorWindow?.signupDelta ?? null, label)}
            icon={UserPlus}
            accent="blue"
          />
          <KpiTile
            label="Claimants"
            value={formatNumber(overview.claimants)}
            sub={formatDeltaSub(
              overview.priorWindow?.claimantDelta ?? null,
              "Signups → bonus",
            )}
            icon={Sparkles}
            accent="blue"
          />
          <KpiTile
            label="Claim conversion"
            value={`${overview.conversionPct.toFixed(1)}%`}
            sub="Claimants / signups"
            icon={Percent}
            accent="blue"
          />
          <KpiTile
            label="Total bonus cost"
            value={formatCurrency(overview.totalCost)}
            sub={formatDeltaSub(
              overview.priorWindow?.costDelta ?? null,
              "House payout",
            )}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Avg per claim"
            value={formatCurrency(overview.avgPerClaim)}
            sub="House cost / claimant"
            icon={Hash}
            accent="rose"
          />
          <KpiTile
            label="Avg per signup"
            value={formatCurrency(overview.avgPerSignup)}
            sub="Cost / cohort head"
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Median time-to-claim"
            value={formatHours(overview.medianHoursToClaim)}
            sub="From signup"
            icon={Clock}
            accent="blue"
          />
          <KpiTile
            label="First depositors"
            value={`${formatNumber(overview.firstDepositors)} · ${overview.firstDepositConversionPct.toFixed(1)}%`}
            sub="Cohort → deposit"
            icon={Wallet}
            accent="blue"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-blue-500/[0.08] blur-2xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-12 -bottom-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={LineChartIcon}
              title={`Daily signups + claims — ${label}`}
            />
            <div className="mt-3">
              <SignupDailyChart daily={daily} />
            </div>
            {/* Legend — signups blue (neutral acquisition), claims rose
                (house cost). Sub-line below the chart calls this out
                so the colour choice reads correctly. */}
            <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-blue-500" />
                <span>Signups (acquisition · neutral)</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-rose-500" />
                <span>Bonus claims (house cost)</span>
              </span>
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

/**
 * Format a period-over-period ratio delta as a compact sub-label,
 * arrow + percent + fallback when the prior frame is null.
 *
 * NOTE: visual semantics here are deliberately uncoloured — the
 * KpiTile chooses its accent based on House-POV (cost = rose,
 * acquisition = blue) and the delta string is informational only.
 */
function formatDeltaSub(
  delta: number | null,
  fallback: string,
): string {
  if (delta === null) return fallback;
  if (delta === 0) return "no change vs prior";
  const arrow = delta > 0 ? "▲" : "▼";
  return `${arrow} ${(Math.abs(delta) * 100).toFixed(1)}% vs prior`;
}

/**
 * Pretty-print an hours-since duration. Sub-hour → minutes, sub-day
 * → hours, then days. Same helper shape used by the existing
 * /rewards/analytics signup tab so the page family stays consistent.
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
