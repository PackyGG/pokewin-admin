import Link from "next/link";
import {
  Network,
  Users,
  Layers,
  Trophy,
  TrendingUp,
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
  getRewardsStackingAnalysis,
  type StackingBand,
  type TopStacker,
} from "@/lib/queries/insights-rewards/stacking-analysis";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Stacking tab — multi-category claimants + their LTV proxy.
 *
 * Buckets claimants by distinct-category count (1 / 2 / 3 / 4+), then
 * surfaces per-band:
 *   - userCount
 *   - avgRewardCost (per user)
 *   - avgWager (per user, gameplay only)
 *   - avgLtvProxy (wager − payouts per user)
 *
 * House-POV: avg-reward-cost = rose (we paid out); avg-LTV-proxy =
 * emerald when positive (house up) / rose when negative.
 *
 * Top stackers list — 10 users with the most distinct reward types
 * claimed in the window, ordered by category count then by reward $.
 * Each row links to /users/[id].
 */
export async function StackingTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getRewardsStackingAnalysis(period),
    null,
    "insights-rewards.stacking",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Rewards — Stacking"
        hint="The stacking-analysis query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  if (data.totalClaimants === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Network}
          title={`No claimants in ${label.toLowerCase()}`}
          description="No reward claimants in this window — stacking analysis cannot be computed."
          compact
        />
      </div>
    );
  }

  const stackerBand = data.bands.find((b) => b.band === 4);
  const singleBand = data.bands.find((b) => b.band === 1);

  return (
    <div className="space-y-6">
      {/* Headline strip */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Total claimants"
            value={formatNumber(data.totalClaimants)}
            sub={label}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="4+ stackers"
            value={
              stackerBand ? formatNumber(stackerBand.userCount) : "0"
            }
            sub={
              stackerBand
                ? `${stackerBand.share.toFixed(1)}% of claimants`
                : "0%"
            }
            icon={Network}
            accent="rose"
          />
          <KpiTile
            label="Single-category"
            value={
              singleBand ? formatNumber(singleBand.userCount) : "0"
            }
            sub={
              singleBand
                ? `${singleBand.share.toFixed(1)}% of claimants`
                : "0%"
            }
            icon={Layers}
            accent="blue"
          />
          <KpiTile
            label="LTV lift (4+ vs single)"
            value={
              data.ltvLift4xVsSingle === null
                ? "—"
                : `${data.ltvLift4xVsSingle.toFixed(2)}×`
            }
            sub={
              data.ltvLift4xVsSingle === null
                ? "Single band LTV ≤ 0"
                : "Avg in-window GGR multiple"
            }
            icon={TrendingUp}
            accent={
              data.ltvLift4xVsSingle === null
                ? "blue"
                : data.ltvLift4xVsSingle >= 1
                  ? "emerald"
                  : "rose"
            }
          />
          <KpiTile
            label="Max categories"
            value={
              data.topStackers[0]
                ? `${data.topStackers[0].categoryCount}`
                : "—"
            }
            sub={
              data.topStackers[0]
                ? `Top stacker: ${data.topStackers[0].username ?? data.topStackers[0].userId.slice(0, 8)}`
                : "—"
            }
            icon={Trophy}
            accent="rose"
          />
        </div>
      </FadeIn>

      {/* Per-band breakdown table */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Layers} title="Bands by category count" />
          <BandsTable bands={data.bands} />
        </div>
      </FadeIn>

      {/* Top stackers */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Trophy} title="Top stackers" />
          <TopStackersTable rows={data.topStackers} />
        </div>
      </FadeIn>
    </div>
  );
}

function BandsTable({ bands }: { bands: StackingBand[] }) {
  if (bands.every((b) => b.userCount === 0)) {
    return (
      <EmptyState
        icon={Layers}
        title="No band data"
        description="No claimants distributed across categories in this window."
        compact
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="grid grid-cols-[1.5fr_repeat(5,_minmax(0,_8rem))] gap-3 border-b border-border/60 bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Band</span>
        <span className="text-right">Users</span>
        <span className="text-right">Share</span>
        <span className="text-right">Avg reward cost</span>
        <span className="text-right">Avg wager</span>
        <span className="text-right">Avg LTV proxy</span>
      </div>
      <ul>
        {bands.map((b) => {
          const ltvIsPositive = b.avgLtvProxy >= 0;
          return (
            <li
              key={b.band}
              className="grid grid-cols-[1.5fr_repeat(5,_minmax(0,_8rem))] items-center gap-3 border-b border-border/60 px-4 py-2.5 text-xs last:border-b-0"
            >
              <span className="truncate text-sm font-medium">{b.label}</span>
              <span className="text-right tabular-nums text-muted-foreground">
                {formatNumber(b.userCount)}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {b.share.toFixed(1)}%
              </span>
              <span className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(b.avgRewardCost)}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {formatCurrency(b.avgWager)}
              </span>
              <span
                className={cn(
                  "text-right font-semibold tabular-nums",
                  ltvIsPositive
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {ltvIsPositive ? "+" : "−"}
                {formatCurrency(Math.abs(b.avgLtvProxy))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TopStackersTable({ rows }: { rows: TopStacker[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="No top stackers"
        description="No claimants with 2+ reward categories in this window."
        compact
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="grid grid-cols-[2rem_1.6fr_repeat(4,_minmax(0,_7rem))] gap-3 border-b border-border/60 bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>#</span>
        <span>User</span>
        <span className="text-right">Categories</span>
        <span className="text-right">Reward total</span>
        <span className="text-right">Wager total</span>
        <span className="text-right">LTV proxy</span>
      </div>
      <ul>
        {rows.map((r, idx) => {
          const ltvIsPositive = r.ltvProxy >= 0;
          return (
            <li key={r.userId}>
              <Link
                href={`/users/${r.userId}`}
                className="grid grid-cols-[2rem_1.6fr_repeat(4,_minmax(0,_7rem))] items-center gap-3 border-b border-border/60 px-4 py-2.5 text-xs transition-colors last:border-b-0 hover:bg-muted/30"
              >
                <span className="text-right tabular-nums text-muted-foreground">
                  {idx + 1}.
                </span>
                <span className="truncate font-medium">
                  {r.username ?? `${r.userId.slice(0, 6)}…`}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {r.categoryCount}
                </span>
                <span className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.rewardTotal)}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {formatCurrency(r.wagerTotal)}
                </span>
                <span
                  className={cn(
                    "text-right font-semibold tabular-nums",
                    ltvIsPositive
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {ltvIsPositive ? "+" : "−"}
                  {formatCurrency(Math.abs(r.ltvProxy))}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
