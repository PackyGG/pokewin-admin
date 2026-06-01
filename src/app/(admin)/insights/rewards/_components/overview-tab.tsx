import {
  TrendingDown,
  TrendingUp,
  Users,
  Percent,
  LineChart as LineChartIcon,
  Hash,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
  StatPanel,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { AnimatedNumber } from "@/components/animated-number";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getRewardsCrossCategorySummary,
  type RewardsCrossCategorySummary,
} from "@/lib/queries/insights-rewards/cross-category-summary";
import {
  getRewardsCategorySpendBreakdown,
  type CategorySpendRow,
} from "@/lib/queries/insights-rewards/category-spend-breakdown";
import { RewardsCostChart } from "@/app/(admin)/rewards/analytics/rewards-chart";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Overview tab on /insights/rewards. Top-line cross-reward view:
 *
 *   - Total marketing cost across every reward category.
 *   - Active claimant count + payout count.
 *   - GGR for the same window, marketing cost as % of GGR + % of wager.
 *   - Period-over-period deltas vs the prior equal window.
 *   - Per-category breakdown panel with share bars.
 *   - Daily cost chart (rose, House-POV).
 *
 * House-POV: every reward is money the house GIVES users → rose
 * accent. ROI lens (cost vs GGR) prints emerald when the GGR side is
 * larger.
 */
export async function OverviewTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const [summaryRes, spendRes] = await Promise.all([
    safeQuery(
      () => getRewardsCrossCategorySummary(period),
      null,
      "insights-rewards.summary",
    ),
    safeQuery(
      () => getRewardsCategorySpendBreakdown(period),
      null,
      "insights-rewards.spend",
    ),
  ]);
  if (summaryRes.error || !summaryRes.data || spendRes.error || !spendRes.data) {
    return (
      <TileErrorFallback
        label="Rewards — Overview"
        hint="The cross-category summary query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const summary = summaryRes.data;
  const spend = spendRes.data;
  const label = insightsRewardsPeriodLabel(period);

  // Translate the category daily series into the chart-compatible
  // RewardsDailyPoint shape used by RewardsCostChart. Categories
  // unique to /insights are mapped 1:1; total = sum of all per-day
  // category contributions.
  const dailySeries = buildChartDailyPoints(spend.rows);

  if (summary.totalCost === 0 && summary.totalWager === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={TrendingDown}
          title={`No reward activity in ${label.toLowerCase()}`}
          description="No reward payouts and no gameplay activity recorded for this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Headline KPI strip — total cost (rose), active claimants
          (neutral), GGR (signed), marketing % of GGR (rose when high),
          marketing % of wager. */}
      <FadeIn>
        <KpiStrip summary={summary} period={period} />
      </FadeIn>

      {/* Daily cost chart — rose area, same component as
          /rewards/analytics so the chart aesthetic stays consistent
          across the two pages. */}
      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={LineChartIcon}
              title={`Daily marketing cost — ${label}`}
            />
            <div className="mt-3">
              <RewardsCostChart daily={dailySeries} />
            </div>
          </div>
        </div>
      </FadeIn>

      {/* Breakdown panel + ROI summary side-by-side. */}
      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <SectionHeading icon={Hash} title="Spend by category" />
            <div className="mt-3">
              <CategoryBreakdownPanel rows={spend.rows} grandTotal={spend.grandTotal} />
            </div>
          </div>

          <div>
            <SectionHeading icon={TrendingDown} title="Marketing cost summary" />
            <div className="mt-3">
              <StatPanel
                title="Total marketing cost"
                icon={TrendingDown}
                accent="rose"
              >
                <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl">
                  <AnimatedNumber
                    value={summary.totalCost}
                    format="currency"
                    duration={700}
                  />
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatNumber(summary.totalCount)} payouts ·{" "}
                  {formatNumber(summary.activeClaimants)} claimants · {label}
                </p>
                <div className="mt-3 space-y-1 border-t pt-3 text-sm">
                  <SummaryRow
                    label="Total wager (window)"
                    value={formatCurrency(summary.totalWager)}
                  />
                  <SummaryRow
                    label="GGR (window)"
                    value={formatCurrency(summary.ggr)}
                    valueClass={
                      summary.ggr >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                    }
                  />
                  <SummaryRow
                    label="Marketing % of GGR"
                    value={
                      summary.marketingPctOfGgr === null
                        ? "—"
                        : `${summary.marketingPctOfGgr.toFixed(1)}%`
                    }
                  />
                  <SummaryRow
                    label="Marketing % of wager"
                    value={
                      summary.marketingPctOfWager === null
                        ? "—"
                        : `${summary.marketingPctOfWager.toFixed(2)}%`
                    }
                  />
                </div>
              </StatPanel>
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

// ─── KPI strip ──────────────────────────────────────────────────────

function KpiStrip({
  summary,
  period,
}: {
  summary: RewardsCrossCategorySummary;
  period: InsightsRewardsPeriod;
}) {
  const label = insightsRewardsPeriodLabel(period);
  const ggrIsHouseProfit = summary.ggr >= 0;
  const marketingPctOfGgrLabel =
    summary.marketingPctOfGgr === null
      ? "—"
      : `${summary.marketingPctOfGgr.toFixed(1)}%`;
  const marketingPctOfWagerLabel =
    summary.marketingPctOfWager === null
      ? "—"
      : `${summary.marketingPctOfWager.toFixed(2)}%`;

  // Format the period-over-period sub-label as plain text so it slots
  // into the existing KpiTile contract (which takes a string sub). The
  // up/down direction is encoded as an arrow glyph so the tile still
  // communicates direction without needing a custom slot.
  const costSub = formatDeltaSub(
    summary.priorWindow?.costDelta ?? null,
    label,
    "higherIsBad",
  );
  const claimantSub = formatDeltaSub(
    summary.priorWindow?.claimantDelta ?? null,
    `${formatNumber(summary.totalCount)} payouts`,
    "higherIsGood",
  );
  const countSub = formatDeltaSub(
    summary.priorWindow?.countDelta ?? null,
    label,
    "higherIsBad",
  );

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <KpiTile
        label="Total marketing cost"
        value={formatCurrency(summary.totalCost)}
        sub={costSub}
        icon={TrendingDown}
        accent="rose"
      />
      <KpiTile
        label="Active claimants"
        value={formatNumber(summary.activeClaimants)}
        sub={claimantSub}
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="GGR (window)"
        value={`${ggrIsHouseProfit ? "+" : "−"}${formatCurrency(Math.abs(summary.ggr))}`}
        sub={ggrIsHouseProfit ? "House profit" : "House loss"}
        icon={ggrIsHouseProfit ? TrendingUp : TrendingDown}
        accent={ggrIsHouseProfit ? "emerald" : "rose"}
      />
      <KpiTile
        label="Marketing % of GGR"
        value={marketingPctOfGgrLabel}
        sub={
          summary.marketingPctOfGgr === null
            ? "GGR ≤ 0"
            : summary.marketingPctOfGgr <= 30
              ? "Healthy spend ratio"
              : summary.marketingPctOfGgr <= 60
                ? "Heavy spend"
                : "Marketing > 60% of GGR"
        }
        icon={Percent}
        accent="rose"
      />
      <KpiTile
        label="Marketing % of wager"
        value={marketingPctOfWagerLabel}
        sub={
          summary.marketingPctOfWager === null
            ? "No wagers"
            : "Reward $ per wager $"
        }
        icon={Percent}
        accent="rose"
      />
      <KpiTile
        label="Reward payouts"
        value={formatNumber(summary.totalCount)}
        sub={countSub}
        icon={Hash}
        accent="rose"
      />
    </div>
  );
}

/**
 * Format a period-over-period delta as a compact sub-label string so
 * it fits the existing KpiTile sub contract (which accepts string only).
 * The arrow glyph encodes the direction, and the caller's
 * `higherIsBad` flag flips the semantic colour expectation (but the
 * string itself stays uncoloured — the surrounding tile chooses the
 * accent). Returns the fallback label when the delta is null (typical
 * for the "all" period which has no prior frame).
 */
function formatDeltaSub(
  delta: number | null,
  fallback: string,
  semantic: "higherIsBad" | "higherIsGood",
): string {
  void semantic;
  if (delta === null) return fallback;
  if (delta === 0) return "no change vs prior";
  const isUp = delta > 0;
  const arrow = isUp ? "▲" : "▼";
  const pct = `${(Math.abs(delta) * 100).toFixed(1)}%`;
  return `${arrow} ${pct} vs prior`;
}

function SummaryRow({
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
      <span className={cn("font-medium tabular-nums", valueClass)}>
        {value}
      </span>
    </div>
  );
}

// ─── Category breakdown panel ──────────────────────────────────────

function CategoryBreakdownPanel({
  rows,
  grandTotal,
}: {
  rows: CategorySpendRow[];
  grandTotal: number;
}) {
  if (grandTotal === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Hash}
          title="No category spend in this window"
          description="No reward payouts in any category for the selected period. Try a longer period."
          compact
        />
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-2xl border bg-card p-4 sm:p-5">
      {rows.map((row) => (
        <div key={row.key} className="rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{row.label}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                · {formatNumber(row.count)} payouts
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                · {formatNumber(row.claimants)} users
              </span>
            </div>
            <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(row.total)}
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
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Translate per-category daily series into the chart-compatible
 * `RewardsDailyPoint` shape so we can reuse the existing
 * `RewardsCostChart` component without forking a second chart. The
 * chart only needs `date + total`; the per-category fields stay 0
 * since the Overview tab focuses on the total line.
 */
function buildChartDailyPoints(
  rows: CategorySpendRow[],
): Array<{
  date: string;
  bonuses: number;
  rakeback: number;
  affiliate: number;
  rainRace: number;
  signupPack: number;
  creatorTip: number;
  waitlist: number;
  total: number;
}> {
  const byDate = new Map<
    string,
    {
      date: string;
      bonuses: number;
      rakeback: number;
      affiliate: number;
      rainRace: number;
      signupPack: number;
      creatorTip: number;
      waitlist: number;
      total: number;
    }
  >();
  for (const row of rows) {
    for (const pt of row.dailySeries) {
      const existing = byDate.get(pt.date) ?? {
        date: pt.date,
        bonuses: 0,
        rakeback: 0,
        affiliate: 0,
        rainRace: 0,
        signupPack: 0,
        creatorTip: 0,
        waitlist: 0,
        total: 0,
      };
      switch (row.key) {
        case "bonuses":
          existing.bonuses += pt.total;
          break;
        case "rakeback":
          existing.rakeback += pt.total;
          break;
        case "affiliate":
          existing.affiliate += pt.total;
          break;
        case "rainRace":
          existing.rainRace += pt.total;
          break;
        case "signupPack":
          existing.signupPack += pt.total;
          break;
        case "creatorTip":
          existing.creatorTip += pt.total;
          break;
        case "waitlist":
          existing.waitlist += pt.total;
          break;
      }
      existing.total += pt.total;
      byDate.set(pt.date, existing);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
