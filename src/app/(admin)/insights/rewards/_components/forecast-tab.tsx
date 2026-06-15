import {
  Users,
  TrendingUp,
  Sigma,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getRewardsForecasting,
  type CategoryForecastRow,
} from "@/lib/queries/insights-rewards/forecasting";
import { type InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { ForecastLineChart } from "./forecast-line-chart";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { compareForecast } from "@/lib/clickhouse/compare/insights-forecast";

/**
 * Forecast tab — 60d historical line per category + 30d projection.
 *
 * For each category we render a small area chart of the trailing 60
 * days of daily spend, plus a tile showing the 7d trailing average
 * and the projected 30d spend (avg × 30). Cards are sorted by
 * projected 30d spend descending so the highest-future-cost categories
 * float to the top.
 *
 * Forecast logic is intentionally simple — a 7-day moving average
 * scaled to 30 days. No ML, no seasonality decomposition. The chart
 * shows the actual line so admins can sanity-check the trend manually.
 *
 * Fixed history horizon (60d) and fixed forecast horizon (30d) — the
 * active page period selector is accepted for symmetry but ignored.
 */
export async function ForecastTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  void period;
  const { data, error } = await safeQuery(
    () => getRewardsForecasting(),
    null,
    "insights-rewards.forecast",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Rewards — Forecast"
        hint="The forecasting query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  void compareForecast(data);
  const projectedTotal = data.rows.reduce((a, r) => a + r.projected30d, 0);
  const trailingTotal = data.rows.reduce(
    (a, r) => a + r.trailingSevenAvg,
    0,
  );
  const histTotal = data.rows.reduce(
    (a, r) =>
      a + r.dailyHistory.reduce((s, p) => s + p.total, 0),
    0,
  );

  if (histTotal === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={TrendingUp}
          title="No history to forecast on"
          description="No reward payouts in the trailing 60 days — forecast skipped."
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
            label={`History total (${data.historyDays}d)`}
            value={formatCurrency(histTotal)}
            sub="All categories combined"
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="Trailing 7d daily avg"
            value={formatCurrency(trailingTotal)}
            sub="Run-rate basis"
            icon={TrendingUp}
            accent="rose"
          />
          <KpiTile
            label={`Projected ${data.forecastDays}d spend`}
            value={formatCurrency(projectedTotal)}
            sub="7d avg × 30"
            icon={TrendingUp}
            accent="rose"
          />
          <KpiTile
            label="Top category projection"
            value={
              data.rows[0]
                ? formatCurrency(data.rows[0].projected30d)
                : "—"
            }
            sub={data.rows[0] ? data.rows[0].label : "—"}
            icon={Users}
            accent="rose"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={TrendingUp}
            title={`Per-category trending (${data.historyDays}d history → ${data.forecastDays}d projection)`}
          />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.rows.map((row) => (
              <ForecastCard key={row.key} row={row} />
            ))}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

function ForecastCard({ row }: { row: CategoryForecastRow }) {
  // Mute zero-projection categories — they still render so admins see
  // they exist, but the tile is dimmed to keep focus on the active
  // categories. Hover keeps everything legible.
  const isQuiet = row.projected30d === 0;
  return (
    <div
      className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
      />
      <div className="relative">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-semibold tracking-tight">
            {row.label}
          </p>
          {isQuiet && (
            <span className="shrink-0 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Quiet
            </span>
          )}
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400">
          {formatCurrency(row.projected30d)}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Projected 30d spend ·{" "}
          <span className="tabular-nums">
            {formatCurrency(row.trailingSevenAvg)}
          </span>{" "}
          /day avg
        </p>
        <div className="mt-3">
          <ForecastLineChart data={row.dailyHistory} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-[11px] tabular-nums text-muted-foreground">
          <div>
            <p className="uppercase tracking-wider">7d avg</p>
            <p className="mt-0.5 text-foreground">
              {formatCurrency(row.trailingSevenAvg)}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wider">History days</p>
            <p className="mt-0.5 text-foreground">
              {formatNumber(row.dailyHistory.length)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
