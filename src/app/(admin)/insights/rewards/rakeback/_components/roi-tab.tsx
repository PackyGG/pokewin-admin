import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Users,
  Percent,
} from "lucide-react";
import { SectionHeading, KpiTile, StatPanel, PanelRow } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  getRakebackRoi,
  type RakebackRoiLookback,
} from "@/lib/queries/insights-rewards/rakeback/roi";
import { type InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { RakebackRoiLookbackFilter } from "./roi-lookback-filter";

/**
 * ROI tab. Rakeback cost in window vs claimants' subsequent gameplay
 * GGR in the chosen lookback. The page exposes a lookback selector
 * (3/7/14/30/60 days) via `?lookback=`.
 *
 * House-POV reminder for the colour mapping on this tab specifically:
 *   - cost                  = money we paid out → rose
 *   - subsequent GGR        = house gameplay profit → emerald when > 0
 *   - net return (GGR-cost) = emerald when positive (we recovered),
 *                             rose when negative (cost > recoup)
 *   - roi ratio             = same sign as netReturn
 */
export async function RoiTab({
  period,
  lookback,
}: {
  period: InsightsRewardsPeriod;
  lookback: RakebackRoiLookback;
}) {
  const roiRes = await safeQuery(
    () => getRakebackRoi(period, lookback),
    null,
    "insights-rewards-rakeback.roi",
  );
  if (roiRes.error || !roiRes.data) {
    return (
      <TileErrorFallback
        label="Rakeback — ROI"
        hint="The ROI query failed."
        size="panel"
      />
    );
  }
  const data = roiRes.data;
  if (data.cost === 0 && data.claimants === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={TrendingUp}
          title="No rakeback to measure"
          description="No rakeback was paid in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const ggrAccent = data.subsequentGgr >= 0 ? "emerald" : "rose";
  const netAccent = data.netReturn >= 0 ? "emerald" : "rose";
  const roiPct =
    data.roiRatio === null ? "—" : `${(data.roiRatio * 100).toFixed(1)}%`;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            ROI compares the rakeback paid in the active window to each
            claimant&rsquo;s wager-net-of-payouts in the trailing lookback
            window from their first claim.
            {data.lookbackDays !== null && (
              <> Current lookback: <strong>{data.lookbackDays}d</strong>.</>
            )}
            {data.lookbackDays === null && (
              <> Lookback: full forward history (lifetime period).</>
            )}
          </p>
          <RakebackRoiLookbackFilter />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Cost"
            value={formatCurrency(data.cost)}
            sub="Rakeback paid in window"
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Subsequent GGR"
            value={`${data.subsequentGgr >= 0 ? "+" : "−"}${formatCurrency(Math.abs(data.subsequentGgr))}`}
            sub="Claimants' wager − payouts"
            icon={data.subsequentGgr >= 0 ? TrendingUp : TrendingDown}
            accent={ggrAccent}
          />
          <KpiTile
            label="Net return"
            value={`${data.netReturn >= 0 ? "+" : "−"}${formatCurrency(Math.abs(data.netReturn))}`}
            sub="GGR − cost"
            icon={DollarSign}
            accent={netAccent}
          />
          <KpiTile
            label="ROI ratio"
            value={roiPct}
            sub={
              data.roiRatio === null
                ? "Cost = 0"
                : data.roiRatio >= 1
                  ? "Recovered"
                  : "Below cost"
            }
            icon={Percent}
            accent={netAccent}
          />
        </div>
      </FadeIn>

      <FadeIn>
        <SectionHeading icon={Users} title="Cohort lens" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <StatPanel title="Claimants measured" icon={Users} accent="blue">
            <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-blue-600 dark:text-blue-400 sm:text-3xl">
              {formatNumber(data.claimants)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Distinct rakeback claimants whose forward gameplay was scored
            </p>
            <div className="mt-3 space-y-0.5 border-t pt-3 text-sm">
              <PanelRow
                label="Avg rakeback / claimant"
                value={
                  data.claimants > 0
                    ? formatCurrency(data.cost / data.claimants)
                    : "—"
                }
              />
              <PanelRow
                label="Avg GGR / claimant"
                value={
                  data.claimants > 0
                    ? formatCurrency(data.subsequentGgr / data.claimants)
                    : "—"
                }
                valueClassName={
                  data.subsequentGgr >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
              <PanelRow
                label="Avg net / claimant"
                value={
                  data.claimants > 0
                    ? formatCurrency(data.netReturn / data.claimants)
                    : "—"
                }
                valueClassName={
                  data.netReturn >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
            </div>
          </StatPanel>
          <StatPanel
            title="Recovery"
            icon={data.netReturn >= 0 ? TrendingUp : TrendingDown}
            accent={netAccent}
          >
            <p
              className={`text-2xl font-bold leading-tight tracking-tight tabular-nums sm:text-3xl ${
                netAccent === "emerald"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }`}
            >
              {roiPct}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              GGR returned per $1 of rakeback cost
            </p>
            <div className="mt-3 space-y-0.5 border-t pt-3 text-sm">
              <PanelRow label="Cost" value={formatCurrency(data.cost)} />
              <PanelRow
                label="Subsequent GGR"
                value={formatCurrency(data.subsequentGgr)}
                valueClassName={
                  data.subsequentGgr >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
              <PanelRow
                label="Net return"
                value={formatCurrency(data.netReturn)}
                valueClassName={
                  data.netReturn >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
            </div>
          </StatPanel>
        </div>
      </FadeIn>
    </div>
  );
}
