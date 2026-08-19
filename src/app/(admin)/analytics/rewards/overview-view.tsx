import {
  TrendingDown,
  TrendingUp,
  Users,
  Percent,
  LineChart as LineChartIcon,
  Hash,
  Gift,
  Wallet,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getRewardProgramSpend,
  REWARD_PROGRAM_LABELS,
  type RewardProgramBreakdown,
  type RewardProgramKey,
} from "@/lib/queries/insights-rewards/program-spend";
import {
  getRewardsCrossCategorySummary,
  type RewardsCrossCategorySummary,
} from "@/lib/queries/insights-rewards/cross-category-summary";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { ProgramCard } from "./program-card";
import { ProgramTrendChart, type ProgramTrendPoint } from "./program-trend-chart";
import { MONEY_OUT } from "./program-meta";
import { DailyPackUnlockConfig } from "./daily-pack-unlock-config";

/**
 * Rewards → Overview. Answers three questions in order:
 *
 *   1. What did rewards cost us this window, and is that a lot? (KPI strip —
 *      spend against GGR and against wager, so the number has a denominator.)
 *   2. Which program moved, and when? (stacked daily cost by program.)
 *   3. How does each program compare? (one card per program.)
 *
 * The GGR / wager denominators come from `getRewardsCrossCategorySummary`,
 * the same canonical window figures /ggr and the dashboard use — a separate
 * safeQuery, so if it fails the program breakdown still renders.
 */
export async function RewardsOverviewView({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const [spendRes, summaryRes] = await Promise.all([
    safeQuery(
      () => getRewardProgramSpend(period),
      null,
      "analytics.rewards.programSpend",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRewardsCrossCategorySummary(period),
      null,
      "analytics.rewards.summary",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  if (spendRes.error || !spendRes.data) {
    return (
      <TileErrorFallback
        label="Reward programs"
        hint="The program-spend query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const spend = spendRes.data;
  const summary = summaryRes.error ? null : summaryRes.data;
  const label = insightsRewardsPeriodLabel(period);

  if (spend.rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Gift}
          title={`No reward spend in ${label.toLowerCase()}`}
          description="No program paid anything out in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const named = spend.rows.filter((r) => r.key !== "other");
  const other = spend.rows.find((r) => r.key === "other") ?? null;
  const trend = buildTrend(spend);

  return (
    <div className="space-y-6">
      <FadeIn>
        <KpiStrip spend={spend} summary={summary} period={period} />
      </FadeIn>

      <FadeIn>
        <DailyPackUnlockConfig />
      </FadeIn>

      <FadeIn>
        <div className="rounded-2xl border bg-card p-4 sm:p-5">
          <SectionHeading
            icon={LineChartIcon}
            title={`Daily cost by program — ${label}`}
            action={
              <span className="text-xs text-muted-foreground">
                Stacked · top of the stack is the daily total
              </span>
            }
          />
          <div className="mt-3">
            <ProgramTrendChart
              data={trend.points}
              programs={trend.programs}
              labels={REWARD_PROGRAM_LABELS}
            />
          </div>
        </div>
      </FadeIn>

      <FadeIn>
        <section className="space-y-3">
          <SectionHeading
            icon={Hash}
            title="Programs"
            action={
              <span className="text-xs text-muted-foreground">
                {formatCurrency(spend.namedTotal)} across{" "}
                {spend.activePrograms} active
              </span>
            }
          />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {named.map((row) => (
              <ProgramCard key={row.key} row={row} />
            ))}
          </div>
        </section>
      </FadeIn>

      {other && (
        <FadeIn>
          <section className="space-y-3">
            <SectionHeading
              icon={Wallet}
              title="Outside the programs"
              action={
                <span className="text-xs text-muted-foreground">
                  {((other.total / spend.grandTotal) * 100).toFixed(1)}% of all
                  reward spend
                </span>
              }
            />
            <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_1fr]">
              <ProgramCard row={other} muted />
              <div className="rounded-lg border border-dashed bg-muted/20 p-3.5">
                <p className="text-xs text-muted-foreground">
                  Money that still left the house but isn&apos;t one of the
                  seven programs — mostly manual admin credits and legacy
                  payouts. Itemised so nothing hides in a residual.
                </p>
                <ul className="mt-3 space-y-1.5">
                  {other.components.map((c) => (
                    <li
                      key={c.label}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="min-w-0 truncate text-muted-foreground">
                        {c.label}
                        <span className="ml-1.5 text-[11px] tabular-nums opacity-70">
                          ({formatNumber(c.count)})
                        </span>
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-medium tabular-nums",
                          MONEY_OUT,
                        )}
                      >
                        {formatCurrency(c.total)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        </FadeIn>
      )}
    </div>
  );
}

// ─── KPI strip ──────────────────────────────────────────────────────

function KpiStrip({
  spend,
  summary,
  period,
}: {
  spend: RewardProgramBreakdown;
  summary: RewardsCrossCategorySummary | null;
  period: InsightsRewardsPeriod;
}) {
  const label = insightsRewardsPeriodLabel(period);
  // Players reached = the largest single-program claimant count. Summing
  // across programs would double-count anyone who claimed from two, and we
  // have no cross-program distinct count here — so this is stated as a floor,
  // not dressed up as an exact figure.
  const reach = spend.rows.reduce((a, r) => Math.max(a, r.claimants), 0);
  const payouts = spend.rows.reduce((a, r) => a + r.count, 0);
  const pctOfGgr = summary?.marketingPctOfGgr ?? null;
  const pctOfWager = summary?.marketingPctOfWager ?? null;
  const ggr = summary?.ggr ?? null;
  const ggrIsProfit = (ggr ?? 0) >= 0;
  const top = spend.rows.find((r) => r.key !== "other");

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <KpiTile
        label="Reward spend"
        value={formatCurrency(spend.grandTotal)}
        sub={label}
        icon={TrendingDown}
        accent="rose"
      />
      <KpiTile
        label="Across programs"
        value={formatCurrency(spend.namedTotal)}
        sub={`${spend.activePrograms} active · ${formatCurrency(spend.otherTotal)} other`}
        icon={Gift}
        accent="rose"
      />
      <KpiTile
        label="Biggest program"
        value={top ? top.label : "—"}
        sub={top ? `${formatCurrency(top.total)} · ${top.share.toFixed(0)}%` : "No spend"}
        icon={TrendingUp}
        accent="amber"
      />
      <KpiTile
        label="Players reached"
        value={formatNumber(reach)}
        sub={`${formatNumber(payouts)} payouts`}
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="% of GGR"
        value={pctOfGgr === null ? "—" : `${pctOfGgr.toFixed(1)}%`}
        sub={
          ggr === null
            ? "GGR unavailable"
            : `GGR ${ggrIsProfit ? "+" : "−"}${formatCurrency(Math.abs(ggr))}`
        }
        icon={Percent}
        accent="rose"
      />
      <KpiTile
        label="% of wager"
        value={pctOfWager === null ? "—" : `${pctOfWager.toFixed(2)}%`}
        sub="Reward $ per wagered $"
        icon={Percent}
        accent="rose"
      />
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Pivot the per-program daily series into one row per date, with a column
 * per program, for the stacked chart. Missing days are filled with 0 so the
 * stack doesn't tear where a program paid nothing.
 */
function buildTrend(spend: RewardProgramBreakdown): {
  points: ProgramTrendPoint[];
  programs: RewardProgramKey[];
} {
  const programs = spend.rows.map((r) => r.key);
  const byDate = new Map<string, ProgramTrendPoint>();
  for (const row of spend.rows) {
    for (const pt of row.dailySeries) {
      const existing =
        byDate.get(pt.date) ??
        ({ date: pt.date } as ProgramTrendPoint);
      existing[row.key] = (existing[row.key] ?? 0) + pt.total;
      byDate.set(pt.date, existing);
    }
  }
  const points = [...byDate.values()]
    .map((p) => {
      const filled: ProgramTrendPoint = { date: p.date };
      for (const key of programs) filled[key] = p[key] ?? 0;
      return filled;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return { points, programs };
}
