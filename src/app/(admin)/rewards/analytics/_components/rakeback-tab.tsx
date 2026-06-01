import {
  Percent,
  PieChart,
  Repeat,
  Clock,
  UserMinus,
  Sigma,
} from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getRakebackAnalytics } from "@/lib/queries/rewards-category-analytics";
import { getRakebackExtras } from "@/lib/queries/rewards-category-extras";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";
import { DistributionBarChart } from "./distribution-bar-chart";

/**
 * Rakeback tab on /rewards/analytics. Sourced from `rakeback_claims`
 * directly (NOT the `ledger_transactions` payout row) so the
 * per-claim wagered USD column is on-hand for the "% of wager" cohort
 * lens. Baseline strip still comes from `ledger_transactions` so it
 * reconciles with Overview by construction.
 *
 * Layers added on top of the baseline strip:
 *
 *   1. Per-claim rate cohort lens (avg + median % of wager) in the
 *      KPI strip.
 *   2. Cadence stats — avg claims/user, median claims/user, median
 *      hours between claims, lapsed claimants (users who claimed in
 *      the prior-equal window but not the current).
 *   3. Per-claim rate distribution histogram (5 buckets).
 *   4. Rakeback-type spread (daily / weekly / monthly) — count, USD
 *      volume, % share. Three small breakdown rows.
 *
 * House-POV: rakeback is money the house GIVES users → rose.
 *
 * PROPOSED (skipped this pass):
 *   - Streak distribution. Per-user consecutive-claim runs would
 *     dominate this query — better as a popover. See
 *     `rewards-category-extras.ts` RakebackExtras docstring.
 *   - rake_rate metadata spread. The dedicated `rakeback_claims`
 *     table stores resolved USD only; no per-row rate field. Would
 *     require joining `rakeback_config` to historical periods and
 *     produces a config view, not an observation. PROPOSED.
 */
export async function RakebackTab({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const [data, extras] = await Promise.all([
    getRakebackAnalytics(period),
    getRakebackExtras(period),
  ]);
  const base = baseDeepStatsTiles(data, periodLabel, {
    countSub: "Rakeback claims",
    avgPerUserSub: "avg per claimant",
  });
  const tiles: DeepStatsTile[] = [
    ...base,
    {
      label: "Avg % of wager",
      value: `${(extras.avgRakebackPctOfWager * 100).toFixed(2)}%`,
      sub: "Total rakeback / total wager",
      icon: Percent,
    },
    {
      label: "Median % of wager",
      value: `${(extras.medianRakebackPctOfWager * 100).toFixed(2)}%`,
      sub: "Per-claim middle ratio",
      icon: Percent,
    },
    {
      label: "Avg claims / user",
      value: extras.avgClaimsPerUser.toFixed(1),
      sub: `Median ${formatNumber(extras.medianClaimsPerUser)} per user`,
      icon: Repeat,
    },
    {
      label: "Median gap between claims",
      value: formatHours(extras.medianHoursBetweenClaims),
      sub: "Across users with ≥2 claims",
      icon: Clock,
    },
    {
      label: "Lapsed claimants",
      value:
        extras.lapsedClaimants === null
          ? "—"
          : formatNumber(extras.lapsedClaimants),
      sub:
        extras.lapsedClaimants === null
          ? "Not defined for all-time"
          : "Prior window only",
      icon: UserMinus,
    },
  ];
  return (
    <div className="space-y-6">
      <CategoryDeepStatsPanel
        data={data}
        periodLabel={periodLabel}
        headerIcon={Percent}
        headerTitle="Rakeback"
        tiles={tiles}
        unitLabel="claims"
        emptyTitle="No rakeback claims in this window"
        emptyDescription={`No rakeback was claimed in the ${periodLabel.toLowerCase()} period. Try a longer period.`}
      />

      {/* Per-claim ratio distribution */}
      {data.count > 0 && (
        <div className="space-y-3">
          <SectionHeading
            icon={PieChart}
            title="Per-claim rate distribution"
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              How much of the wager each claim returns as rakeback.
            </p>
            <div className="mt-3">
              <DistributionBarChart
                data={extras.rateBuckets}
                metric="count"
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {extras.rateBuckets.map((b) => (
                <div
                  key={b.label}
                  className="rounded-lg border bg-muted/20 p-2.5"
                >
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {b.label}
                  </p>
                  <p className="mt-0.5 text-sm font-bold tabular-nums">
                    {formatNumber(b.count)}
                  </p>
                  <p className="text-[10px] tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(b.volume)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Rakeback type spread — daily / weekly / monthly */}
      {data.count > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={Sigma} title="Spread by rakeback type" />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <div className="space-y-2">
              {extras.rakebackTypeSpread.map((row) => (
                <div
                  key={row.type}
                  className="rounded-lg border bg-muted/20 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium capitalize">
                        {row.type}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatNumber(row.count)} claims
                      </span>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(row.volume)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
                      <div
                        className="h-full rounded-sm bg-rose-500/60 transition-all"
                        style={{ width: `${row.share}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {row.share.toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Pretty-print an hours-since duration. Sub-hour → minutes, sub-day
 * → hours, then days. Defensive against NaN / negative values which
 * would imply clock skew or empty data.
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
