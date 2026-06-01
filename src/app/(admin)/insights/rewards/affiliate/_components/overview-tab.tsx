import {
  Users,
  TrendingDown,
  TrendingUp,
  Sigma,
  Percent,
  LineChart as LineChartIcon,
} from "lucide-react";
import {
  KpiTile,
  SectionHeading,
  StatPanel,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getAffiliateOverview } from "@/lib/queries/insights-rewards/affiliate/overview";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { CommissionChart } from "./commission-chart";

/**
 * Overview tab — top-line per-affiliate ROI snapshot.
 *
 * KPI strip carries 5 tiles:
 *   - Active affiliates (count of distinct affiliates paid in window)
 *   - Total commission paid (rose, house-cost POV)
 *   - Downstream wager (emerald — wager is house-positive)
 *   - Avg commission per affiliate (rose)
 *   - ROI (emerald when positive, rose when negative)
 *
 * Below: daily commission area chart (rose) and a side panel that
 * surfaces:
 *   - Commission % of downstream wager
 *   - Distinct referred users active in window
 *   - Total claim count
 */
export async function AffiliateOverviewTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getAffiliateOverview(period),
    null,
    "insights-rewards-affiliate.overview",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Overview"
        hint="The overview summary query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  if (
    data.totalCommissionPaid === 0 &&
    data.downstreamWager === 0 &&
    data.distinctReferredUsers === 0
  ) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={TrendingDown}
          title={`No affiliate activity in ${label.toLowerCase()}`}
          description="No affiliate claims, no downstream wager, no referred-user activity. Try a longer period."
          compact
        />
      </div>
    );
  }

  const roiPositive = data.roiUsd >= 0;
  const pctLabel =
    data.commissionPctOfWager === null
      ? "—"
      : `${data.commissionPctOfWager.toFixed(2)}%`;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Active affiliates"
            value={formatNumber(data.activeAffiliates)}
            sub={`${formatNumber(data.claimCount)} payouts`}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Commission paid"
            value={formatCurrency(data.totalCommissionPaid)}
            sub={label}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Downstream wager"
            value={formatCurrency(data.downstreamWager)}
            sub={`${formatNumber(data.distinctReferredUsers)} referred users`}
            icon={TrendingUp}
            accent="emerald"
          />
          <KpiTile
            label="Avg per affiliate"
            value={formatCurrency(data.avgCommissionPerAffiliate)}
            sub="Total / active affiliates"
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="ROI (wager − cost)"
            value={`${roiPositive ? "+" : "−"}${formatCurrency(Math.abs(data.roiUsd))}`}
            sub={roiPositive ? "House net-positive" : "House net-negative"}
            icon={roiPositive ? TrendingUp : TrendingDown}
            accent={roiPositive ? "emerald" : "rose"}
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={LineChartIcon}
              title={`Daily commission paid — ${label}`}
            />
            <div className="mt-3">
              <CommissionChart data={data.dailyCommission} />
            </div>
          </div>
        </div>
      </FadeIn>

      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <StatPanel
            title="Commission summary"
            icon={TrendingDown}
            accent="rose"
          >
            <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl">
              <AnimatedNumber
                value={data.totalCommissionPaid}
                format="currency"
                duration={700}
              />
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatNumber(data.claimCount)} payouts ·{" "}
              {formatNumber(data.activeAffiliates)} affiliates · {label}
            </p>
            <div className="mt-3 space-y-1 border-t pt-3 text-sm">
              <Row label="Avg per affiliate" value={formatCurrency(data.avgCommissionPerAffiliate)} />
              <Row label="Distinct referred users" value={formatNumber(data.distinctReferredUsers)} />
              <Row label="Claim count" value={formatNumber(data.claimCount)} />
            </div>
          </StatPanel>

          <StatPanel
            title="ROI summary"
            icon={Percent}
            accent={roiPositive ? "emerald" : "rose"}
          >
            <p
              className={`text-2xl font-bold leading-tight tracking-tight tabular-nums sm:text-3xl ${
                roiPositive
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }`}
            >
              {roiPositive ? "+" : "−"}
              <AnimatedNumber
                value={Math.abs(data.roiUsd)}
                format="currency"
                duration={700}
              />
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Downstream wager minus commission paid · {label}
            </p>
            <div className="mt-3 space-y-1 border-t pt-3 text-sm">
              <Row
                label="Downstream wager"
                value={formatCurrency(data.downstreamWager)}
                valueClass="text-emerald-600 dark:text-emerald-400"
              />
              <Row
                label="Commission paid"
                value={formatCurrency(data.totalCommissionPaid)}
                valueClass="text-rose-600 dark:text-rose-400"
              />
              <Row label="Commission % of wager" value={pctLabel} />
            </div>
          </StatPanel>
        </div>
      </FadeIn>
    </div>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${valueClass ?? ""}`}>
        {value}
      </span>
    </div>
  );
}
