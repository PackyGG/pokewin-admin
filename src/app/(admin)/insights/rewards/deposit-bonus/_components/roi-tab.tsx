import {
  TrendingDown,
  TrendingUp,
  Globe2,
  Plug,
  Clock,
  Sigma,
  Users,
  Percent,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { cn } from "@/lib/utils";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getDepositBonusROI } from "@/lib/queries/insights-rewards/deposit-bonus/roi";
import { getDepositBonusGeoSource } from "@/lib/queries/insights-rewards/deposit-bonus/geo-source";
import { getDepositBonusTimeOfDay } from "@/lib/queries/insights-rewards/deposit-bonus/behavior";

/**
 * ROI & Geo tab:
 *
 *   - ROI lens         : cost vs claimants' subsequent gameplay GGR
 *                          (wager − payouts) in a 14-day forward window
 *                          from each claimant's first in-window claim.
 *                          Blended ROI = totalGgr / totalCost.
 *   - Geo breakdown    : top 12 countries by bonus volume, with avg
 *                          per claimant + share.
 *   - Signup source    : top 10 providers by bonus volume.
 *   - Time-of-day      : hour-of-day + day-of-week distribution heatmaps.
 *
 * House-POV: ROI positive → emerald (we won); ROI negative → rose (we
 * bled). Geo / source totals stay rose (cost). Time-of-day bars are
 * rose (cost intensity).
 */
export async function RoiTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const [roiRes, geoRes, todRes] = await Promise.all([
    safeQuery(
      () => getDepositBonusROI(period),
      null,
      "insights-rewards-deposit-bonus.roi",
    ),
    safeQuery(
      () => getDepositBonusGeoSource(period),
      null,
      "insights-rewards-deposit-bonus.geo",
    ),
    safeQuery(
      () => getDepositBonusTimeOfDay(period),
      null,
      "insights-rewards-deposit-bonus.tod",
    ),
  ]);

  if (roiRes.error || !roiRes.data) {
    return (
      <TileErrorFallback
        label="Deposit Bonus — ROI"
        hint="The ROI query failed."
        size="panel"
      />
    );
  }
  const roi = roiRes.data;
  const geo = geoRes.data;
  const tod = todRes.data;
  const label = insightsRewardsPeriodLabel(period);

  if (roi.cost === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={TrendingDown}
          title={`No bonus cost in ${label.toLowerCase()}`}
          description="ROI can't be measured without bonus payouts."
          compact
        />
      </div>
    );
  }

  const roiPositive = (roi.blendedRoi ?? 0) > 0;

  return (
    <div className="space-y-6">
      {/* — ROI strip — */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Bonus cost"
            value={formatCurrency(roi.cost)}
            sub={`${formatNumber(roi.claimants)} claimants`}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Subsequent wager"
            value={formatCurrency(roi.wager)}
            sub={`${roi.effectiveLookbackDays}d lookback after claim`}
            icon={Sigma}
            accent="emerald"
          />
          <KpiTile
            label="Subsequent payouts"
            value={formatCurrency(roi.payouts)}
            sub="battle refund + upgrader payout"
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="Subsequent GGR"
            value={`${roi.subsequentGgr >= 0 ? "+" : "−"}${formatCurrency(Math.abs(roi.subsequentGgr))}`}
            sub={roi.subsequentGgr >= 0 ? "house profit" : "house loss"}
            icon={roi.subsequentGgr >= 0 ? TrendingUp : TrendingDown}
            accent={roi.subsequentGgr >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="Blended ROI"
            value={
              roi.blendedRoi != null
                ? `${(roi.blendedRoi * 100).toFixed(1)}%`
                : "—"
            }
            sub={
              roi.blendedRoi == null
                ? "no cost"
                : roiPositive
                  ? "earned cost back"
                  : "spent more than recouped"
            }
            icon={Percent}
            accent={roiPositive ? "emerald" : "rose"}
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <StatPanel
            title="Cost vs return"
            icon={Sigma}
            accent={roiPositive ? "emerald" : "rose"}
          >
            <p
              className={cn(
                "text-2xl font-bold leading-tight tracking-tight tabular-nums sm:text-3xl",
                roiPositive
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {roi.blendedRoi != null
                ? `${(roi.blendedRoi * 100).toFixed(1)}%`
                : "—"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              ROI = subsequent GGR / bonus cost
            </p>
            <div className="mt-3 space-y-1 border-t pt-3 text-sm">
              <PanelRow
                label="Bonus cost"
                value={formatCurrency(roi.cost)}
                valueClassName="text-rose-600 dark:text-rose-400"
              />
              <PanelRow
                label="Subsequent GGR"
                value={`${roi.subsequentGgr >= 0 ? "+" : "−"}${formatCurrency(Math.abs(roi.subsequentGgr))}`}
                valueClassName={
                  roi.subsequentGgr >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
              <PanelRow
                label="Net (GGR − cost)"
                value={`${roi.subsequentGgr - roi.cost >= 0 ? "+" : "−"}${formatCurrency(Math.abs(roi.subsequentGgr - roi.cost))}`}
                valueClassName={
                  roi.subsequentGgr - roi.cost >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
              <PanelRow
                label="Avg GGR / claimant"
                value={`${roi.avgGgrPerClaimant >= 0 ? "+" : "−"}${formatCurrency(Math.abs(roi.avgGgrPerClaimant))}`}
                valueClassName={
                  roi.avgGgrPerClaimant >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
              <PanelRow
                label="Claimants"
                value={formatNumber(roi.claimants)}
              />
              <PanelRow
                label="Forward window"
                value={`${roi.effectiveLookbackDays} days`}
              />
            </div>
          </StatPanel>

          <StatPanel
            title="Bonus efficiency"
            icon={Percent}
            accent="rose"
          >
            <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl">
              {roi.cost > 0
                ? `${((roi.cost / Math.max(1, roi.wager)) * 100).toFixed(2)}%`
                : "—"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bonus cost as % of subsequent wager (lower = more
              wager-efficient bonuses)
            </p>
            <div className="mt-3 space-y-1 border-t pt-3 text-sm">
              <PanelRow
                label="Cost / wager"
                value={
                  roi.wager > 0
                    ? `${((roi.cost / roi.wager) * 100).toFixed(2)}%`
                    : "—"
                }
              />
              <PanelRow
                label="Wager / cost"
                value={
                  roi.cost > 0
                    ? `${(roi.wager / roi.cost).toFixed(2)}×`
                    : "—"
                }
              />
              <PanelRow
                label="Avg wager / claimant"
                value={formatCurrency(
                  roi.claimants > 0 ? roi.wager / roi.claimants : 0,
                )}
                valueClassName="text-emerald-600 dark:text-emerald-400"
              />
              <PanelRow
                label="Avg cost / claimant"
                value={formatCurrency(
                  roi.claimants > 0 ? roi.cost / roi.claimants : 0,
                )}
                valueClassName="text-rose-600 dark:text-rose-400"
              />
            </div>
          </StatPanel>
        </div>
      </FadeIn>

      {/* — Geo / signup-source — */}
      {geo && (
        <FadeIn>
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="space-y-3">
              <SectionHeading icon={Globe2} title="Top countries by bonus $" />
              <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
                <GeoSourceBarsList rows={geo.countries} emptyLabel="No country data" />
              </div>
            </div>
            <div className="space-y-3">
              <SectionHeading icon={Plug} title="Top signup sources by bonus $" />
              <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
                <GeoSourceBarsList rows={geo.sources} emptyLabel="No source data" />
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* — Time of day / day of week — */}
      {tod && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading
              icon={Clock}
              title="When are bonuses awarded? (UTC)"
            />
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  By hour of day
                </p>
                <HourlyBars hourly={tod.hourly} />
              </div>
              <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  By day of week
                </p>
                <DowBars daily={tod.daily} />
              </div>
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}

// ─── Lists / heatmap helpers ───────────────────────────────────────

function GeoSourceBarsList({
  rows,
  emptyLabel,
}: {
  rows: Array<{
    key: string;
    label: string;
    userCount: number;
    total: number;
    avgPerUser: number;
    share: number;
  }>;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={emptyLabel}
        description="No data in this window."
        compact
      />
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{r.label}</p>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {formatNumber(r.userCount)} users · {formatCurrency(r.avgPerUser)}{" "}
                avg
              </p>
            </div>
            <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.total)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
              <div
                className="h-full rounded-sm bg-rose-500/60 transition-all"
                style={{ width: `${Math.min(100, r.share)}%` }}
              />
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {r.share.toFixed(1)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function HourlyBars({
  hourly,
}: {
  hourly: Array<{ hour: number; count: number; volume: number }>;
}) {
  const maxCount = Math.max(0, ...hourly.map((h) => h.count));
  return (
    <div className="mt-2 grid grid-cols-12 gap-1">
      {hourly.map((h) => {
        const heightPct = maxCount > 0 ? (h.count / maxCount) * 100 : 0;
        return (
          <div
            key={h.hour}
            className="group flex flex-col items-center"
            title={`${h.hour}:00 — ${h.count} bonuses · ${formatCurrency(h.volume)}`}
          >
            <div className="flex h-20 w-full items-end">
              <div
                className="w-full rounded-t-sm bg-rose-500/60 transition-all group-hover:bg-rose-500"
                style={{ height: `${heightPct}%` }}
              />
            </div>
            <span className="mt-1 text-[9px] tabular-nums text-muted-foreground">
              {h.hour}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DowBars({
  daily,
}: {
  daily: Array<{
    dayOfWeek: number;
    label: string;
    count: number;
    volume: number;
  }>;
}) {
  const maxCount = Math.max(0, ...daily.map((d) => d.count));
  return (
    <div className="mt-2 grid grid-cols-7 gap-2">
      {daily.map((d) => {
        const heightPct = maxCount > 0 ? (d.count / maxCount) * 100 : 0;
        return (
          <div
            key={d.dayOfWeek}
            className="group flex flex-col items-center"
            title={`${d.label} — ${d.count} bonuses · ${formatCurrency(d.volume)}`}
          >
            <div className="flex h-20 w-full items-end">
              <div
                className="w-full rounded-t-sm bg-rose-500/60 transition-all group-hover:bg-rose-500"
                style={{ height: `${heightPct}%` }}
              />
            </div>
            <span className="mt-1 text-[10px] font-medium text-muted-foreground">
              {d.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
