import {
  TrendingDown,
  TrendingUp,
  Users,
  Percent,
  Sigma,
} from "lucide-react";
import {
  KpiTile,
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRaceInsightsROI } from "@/lib/queries/insights-rewards/race/roi";
import { compareRaceRoi } from "@/lib/clickhouse/compare/insights-race-roi";

/**
 * ROI tab. Compares race-prize cost to claimants' subsequent gameplay
 * GGR over a forward lookback (same lookback rules as the
 * cross-category ROI helper).
 *
 * House-POV:
 *   - ROI > 0   → emerald (races drove enough wagers to recoup cost)
 *   - ROI < 0   → rose    (house bled cost)
 *   - ROI = 0   → even
 */
export async function RaceRoiTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRaceInsightsROI(period),
    null,
    "insights-rewards.race.roi",
  );
  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Race — ROI"
        hint="The ROI query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const roi = res.data;
  const label = insightsRewardsPeriodLabel(period);

  void compareRaceRoi(period, roi);

  if (roi.claimantCount === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Percent}
          title={`No race ROI data in ${label.toLowerCase()}`}
          description="No race-prize ledger rows in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const roiPositive = roi.roi !== null && roi.roi >= 0;
  const ggrPositive = roi.subsequentGgr >= 0;
  const roiPct =
    roi.roi === null
      ? "—"
      : `${roi.roi >= 0 ? "+" : "−"}${(Math.abs(roi.roi) * 100).toFixed(1)}%`;

  return (
    <FadeIn>
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Race prize cost"
            value={formatCurrency(roi.cost)}
            sub={`${formatNumber(roi.claimantCount)} winners · ${label}`}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Forward GGR"
            value={
              ggrPositive
                ? `+${formatCurrency(Math.abs(roi.subsequentGgr))}`
                : `−${formatCurrency(Math.abs(roi.subsequentGgr))}`
            }
            sub={`${roi.lookbackDays}d after claim`}
            icon={ggrPositive ? TrendingUp : TrendingDown}
            accent={ggrPositive ? "emerald" : "rose"}
          />
          <KpiTile
            label="ROI"
            value={roiPct}
            sub={
              roi.roi === null
                ? "Cost = 0"
                : roiPositive
                  ? "House recouped"
                  : "House bled cost"
            }
            icon={Percent}
            accent={roiPositive ? "emerald" : "rose"}
          />
          <KpiTile
            label="Avg GGR / winner"
            value={
              roi.avgGgrPerWinner >= 0
                ? `+${formatCurrency(Math.abs(roi.avgGgrPerWinner))}`
                : `−${formatCurrency(Math.abs(roi.avgGgrPerWinner))}`
            }
            sub="Forward GGR / winners"
            icon={Sigma}
            accent={roi.avgGgrPerWinner >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="Winner cohort"
            value={formatNumber(roi.claimantCount)}
            sub="Distinct race winners"
            icon={Users}
            accent="blue"
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <div>
            <SectionHeading
              icon={Sigma}
              title="ROI math"
            />
            <div className="mt-3">
              <StatPanel
                title="Race ROI summary"
                icon={Percent}
                accent={roiPositive ? "emerald" : "rose"}
              >
                <p
                  className={
                    roiPositive
                      ? "text-2xl font-bold leading-tight tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400 sm:text-3xl"
                      : "text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl"
                  }
                >
                  {roiPct}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Forward window: {roi.lookbackDays} day{roi.lookbackDays === 1 ? "" : "s"} after each first claim
                </p>
                <div className="mt-3 space-y-1 border-t pt-3 text-sm">
                  <PanelRow
                    label="Race-prize cost"
                    value={formatCurrency(roi.cost)}
                    valueClassName="text-rose-600 dark:text-rose-400"
                  />
                  <PanelRow
                    label="Forward wagers"
                    value={formatCurrency(roi.subsequentWager)}
                  />
                  <PanelRow
                    label="Forward payouts"
                    value={formatCurrency(roi.subsequentPayout)}
                  />
                  <PanelRow
                    label="Forward GGR"
                    value={
                      ggrPositive
                        ? `+${formatCurrency(Math.abs(roi.subsequentGgr))}`
                        : `−${formatCurrency(Math.abs(roi.subsequentGgr))}`
                    }
                    valueClassName={
                      ggrPositive
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                    }
                  />
                  <PanelRow
                    label="ROI = Forward GGR / Cost"
                    value={roiPct}
                    valueClassName={
                      roiPositive
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                    }
                  />
                </div>
              </StatPanel>
            </div>
          </div>

          <div>
            <SectionHeading icon={Users} title="What ROI tells you" />
            <div className="relative mt-3 overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">ROI &gt; 0:</span>{" "}
                  race winners&apos; subsequent wagers more than covered the prize
                  payout — races are net-positive engagement drivers.
                </li>
                <li>
                  <span className="font-medium text-foreground">ROI &lt; 0:</span>{" "}
                  winners walked with the prize and didn&apos;t put enough back in
                  to recoup the cost. Check the lookback window vs the cohort
                  size before changing tier configuration.
                </li>
                <li>
                  <span className="font-medium text-foreground">Forward window:</span>{" "}
                  short periods (24h / 3d) cap the lookback to the period
                  itself so the math stays bounded. Longer periods sweep up to
                  the default lookback past each first claim.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </FadeIn>
  );
}
