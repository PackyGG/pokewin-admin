import {
  TrendingUp,
  TrendingDown,
  Sigma,
  Coins,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getRewardsROI,
  type RewardsRoiRow,
} from "@/lib/queries/insights-rewards/roi";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * ROI tab — per-category cost vs subsequent gameplay GGR.
 *
 * For each reward category, we compute:
 *   - cost              : reward $ paid to claimants in the cost window
 *   - claimantCount     : distinct claimants
 *   - subsequentGgr     : claimants' wager − payouts in the forward
 *                         lookback (default 14 days, capped to the
 *                         window itself for 24h / 3d)
 *   - roi               : subsequentGgr / cost
 *   - avgGgrPerClaimant : per-user proxy
 *
 * House-POV: positive ROI = emerald (house won), negative = rose
 * (house bled cost without recouping). The blended-ROI headline tile
 * reflects the same colour rule.
 *
 * Lookback is fixed at 14 days for ≥ 7d windows. Shorter windows
 * (24h / 3d) cap the lookback to the window itself so the forward
 * sweep stays bounded.
 */
export async function RoiTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getRewardsROI(period, 14),
    null,
    "insights-rewards.roi",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Rewards — ROI"
        hint="The ROI query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  const blendedRoiLabel =
    data.blendedRoi === null ? "—" : `${data.blendedRoi.toFixed(2)}×`;
  const blendedIsPositive = (data.blendedRoi ?? 0) >= 1;
  const blendedIsHouseProfit = (data.totalSubsequentGgr ?? 0) >= 0;

  if (data.totalCost === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={TrendingUp}
          title={`No reward spend in ${label.toLowerCase()}`}
          description="No reward payouts were made in the selected window — ROI calculation skipped."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Headline strip — blended ROI + cost / GGR totals + lookback. */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Blended ROI"
            value={blendedRoiLabel}
            sub={
              data.blendedRoi === null
                ? "No cost in window"
                : blendedIsPositive
                  ? "Subsequent GGR ≥ spend"
                  : "Subsequent GGR < spend"
            }
            icon={blendedIsPositive ? TrendingUp : TrendingDown}
            accent={
              data.blendedRoi === null
                ? "blue"
                : blendedIsPositive
                  ? "emerald"
                  : "rose"
            }
          />
          <KpiTile
            label="Total spend"
            value={formatCurrency(data.totalCost)}
            sub={label}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Subsequent GGR"
            value={`${blendedIsHouseProfit ? "+" : "−"}${formatCurrency(Math.abs(data.totalSubsequentGgr))}`}
            sub={`Forward ${data.effectiveLookbackDays}d`}
            icon={blendedIsHouseProfit ? TrendingUp : TrendingDown}
            accent={blendedIsHouseProfit ? "emerald" : "rose"}
          />
          <KpiTile
            label="Net for house"
            value={formatCurrency(
              Math.abs(data.totalSubsequentGgr - data.totalCost),
            )}
            sub={
              data.totalSubsequentGgr - data.totalCost >= 0
                ? "Subsequent GGR > spend"
                : "Spend > subsequent GGR"
            }
            icon={Coins}
            accent={
              data.totalSubsequentGgr - data.totalCost >= 0
                ? "emerald"
                : "rose"
            }
          />
          <KpiTile
            label="Forward lookback"
            value={`${data.effectiveLookbackDays} d`}
            sub="Per-claimant forward window"
            icon={Sigma}
            accent="blue"
          />
        </div>
      </FadeIn>

      {/* Per-category ROI table */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={TrendingUp} title="ROI by category" />
          <RoiTable rows={data.rows} />
        </div>
      </FadeIn>
    </div>
  );
}

function RoiTable({ rows }: { rows: RewardsRoiRow[] }) {
  if (rows.length === 0 || rows.every((r) => r.cost === 0)) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No category data in this window"
        description="No reward spend across any category — ROI rows would be empty."
        compact
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="grid grid-cols-[1.4fr_repeat(5,_minmax(0,_8rem))] gap-3 border-b border-border/60 bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Category</span>
        <span className="text-right">Claimants</span>
        <span className="text-right">Cost</span>
        <span className="text-right">Subsequent GGR</span>
        <span className="text-right">Avg GGR / user</span>
        <span className="text-right">ROI</span>
      </div>
      <ul>
        {rows.map((r) => {
          const roiIsPositive = (r.roi ?? 0) >= 1;
          const ggrIsHouseProfit = r.subsequentGgr >= 0;
          // House-POV palette:
          //   - cost  : rose (always — money out)
          //   - ggr   : emerald when ≥ 0, rose when negative
          //   - roi   : emerald when ≥ 1× (we recouped), rose otherwise
          return (
            <li
              key={r.key}
              className="grid grid-cols-[1.4fr_repeat(5,_minmax(0,_8rem))] items-center gap-3 border-b border-border/60 px-4 py-2.5 text-xs last:border-b-0"
            >
              <span className="truncate text-sm font-medium">{r.label}</span>
              <span className="text-right tabular-nums text-muted-foreground">
                {formatNumber(r.claimantCount)}
              </span>
              <span className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(r.cost)}
              </span>
              <span
                className={cn(
                  "text-right tabular-nums",
                  ggrIsHouseProfit
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {ggrIsHouseProfit ? "+" : "−"}
                {formatCurrency(Math.abs(r.subsequentGgr))}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {formatCurrency(r.avgGgrPerClaimant)}
              </span>
              <span
                className={cn(
                  "text-right font-semibold tabular-nums",
                  r.roi === null
                    ? "text-muted-foreground"
                    : roiIsPositive
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                )}
              >
                {r.roi === null ? "—" : `${r.roi.toFixed(2)}×`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

