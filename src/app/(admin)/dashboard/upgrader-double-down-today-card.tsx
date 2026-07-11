import Link from "next/link";
import { Zap, Dices, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/animated-number";
import { formatNumber, formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { UpgraderStats } from "@/lib/queries/dashboard-upgrader";
import type { DoubleDownDashboardStats } from "@/lib/queries/double-down";

/**
 * "Upgrader + Double Down" — MERGED dashboard tile (owner request,
 * 2026-07-02: merge the two lifetime game-type panels into one box, "like
 * deposits / withdrawals", and move it up into the Today boxes row in the
 * slot the Creators Costs card used to occupy (Creators Costs merged into
 * the sibling `RewardCreatorCostsTodayCard`).
 *
 * The two source panels (`UpgraderStatsSection` / `DoubleDownStatsSection`,
 * both removed) were full-width 50/50-row panels with a big gradient hero/
 * volume/activity/hit-rate layout — too tall for a Today-row tile as-is.
 * This merge keeps the SAME full data set (owner request, 2026-07-02: "all
 * data like before with the small boxes") but renders every secondary
 * metric as a small text chip (mirrors the `RewardCreatorCostsTodayCard`
 * pinned chip grid) instead of the large gradient Hero/Sub/Micro cards, so
 * both halves still fit one compact tile:
 *   • Upgrader  — House P&L (hero) + Edge / Wager / Payouts / Bets / Avg
 *     Bet / Players / Hit Rate chips.
 *   • Double Down — House P&L (hero) + Win Rate / Started Rounds / Total
 *     Wager chips.
 * A "View details" link on each half still points to the full page
 * breakdown (`/upgrader`, `/insights/double-down`).
 *
 * Both stats are lifetime aggregates (period-independent), matching the
 * source panels — no today/24h toggle here.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary per CLAUDE.md / Next 15.
 */
export function UpgraderDoubleDownTodayCard({
  upgrader,
  doubleDown,
}: {
  upgrader: Pick<
    UpgraderStats,
    "pnl" | "edge" | "wager" | "payouts" | "bets" | "avgBet" | "uniquePlayers" | "hitRate"
  >;
  doubleDown: Pick<DoubleDownDashboardStats, "netHousePnl" | "winRate" | "rounds" | "staked">;
}) {
  const upgraderProfit = upgrader.pnl >= 0;
  const upgraderColor = upgraderProfit
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const edgePositive = upgrader.edge >= 0;

  const ddProfit = doubleDown.netHousePnl >= 0;
  const ddColor = ddProfit
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const ddWinRatePct =
    doubleDown.winRate === null ? null : doubleDown.winRate * 100;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-card-title text-muted-foreground">
          Upgrader + Double Down
        </CardTitle>
        <span className="text-tiny shrink-0 text-muted-foreground tabular-nums">
          Lifetime
        </span>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {/* Upgrader half. */}
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
              <Zap className="size-3 shrink-0" />
              <span className="truncate">Upgrader</span>
            </p>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <div
              className={cn(
                "truncate text-lg font-bold tabular-nums sm:text-xl",
                upgraderColor,
              )}
            >
              {upgraderProfit ? "+" : "−"}
              <AnimatedNumber value={Math.abs(upgrader.pnl)} format="currency" />
            </div>
            <Link
              href="/upgrader"
              className="flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              Details
              <ArrowRight className="size-2.5" />
            </Link>
          </div>
          <div className="mt-1.5 -mx-0.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            <StatChip label="Edge" tint={edgePositive ? "emerald" : "rose"}>
              <AnimatedNumber value={upgrader.edge} format="percent" />
            </StatChip>
            <StatChip label="Wager" tint="emerald">
              <AnimatedNumber value={upgrader.wager} format="currency" />
            </StatChip>
            <StatChip label="Payouts" tint="rose">
              <AnimatedNumber value={upgrader.payouts} format="currency" />
            </StatChip>
            <StatChip label="Bets">{formatNumber(upgrader.bets)}</StatChip>
            <StatChip label="Avg Bet">{formatCurrency(upgrader.avgBet)}</StatChip>
            <StatChip label="Players">{formatNumber(upgrader.uniquePlayers)}</StatChip>
            <StatChip label="Hit Rate">{upgrader.hitRate.toFixed(1)}%</StatChip>
          </div>
        </div>

        <div className="border-t border-border/50" />

        {/* Double Down half. */}
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400">
              <Dices className="size-3 shrink-0" />
              <span className="truncate">Double Down</span>
            </p>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <div
              className={cn(
                "truncate text-lg font-bold tabular-nums sm:text-xl",
                ddColor,
              )}
            >
              {ddProfit ? "+" : "−"}
              <AnimatedNumber
                value={Math.abs(doubleDown.netHousePnl)}
                format="currency"
              />
            </div>
            <Link
              href="/insights/double-down"
              className="flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              Details
              <ArrowRight className="size-2.5" />
            </Link>
          </div>
          <div className="mt-1.5 -mx-0.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            <StatChip label="Win Rate" tint="purple">
              {ddWinRatePct === null ? "—" : `${ddWinRatePct.toFixed(1)}%`}
            </StatChip>
            <StatChip label="Started Rounds">{formatNumber(doubleDown.rounds)}</StatChip>
            <StatChip label="Total Wager">
              <AnimatedNumber value={doubleDown.staked} format="currency" />
            </StatChip>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Small mini-stat chip on the card face — same footprint as the pinned-line
 * chips on `RewardCreatorCostsTodayCard` (`rounded-md border`, `px-2 py-1.5`,
 * `text-[10px]` label) so restoring the full Upgrader/Double Down data set
 * as small boxes ("all data like before with the small boxes", owner
 * request 2026-07-02) didn't blow up the tile beyond the merged-card
 * footprint. `tint` reuses the House-POV accent the source panels used per
 * metric (Wager = emerald "money in", Payouts = rose "money out", Edge =
 * emerald/rose by sign, Win Rate = purple to match the Double Down accent);
 * metrics without a house-POV lean (Bets, Avg Bet, Players, Hit Rate,
 * rounds, staked) stay neutral foreground text.
 */
function StatChip({
  label,
  tint = "neutral",
  children,
}: {
  label: string;
  tint?: "emerald" | "rose" | "purple" | "neutral";
  children: React.ReactNode;
}) {
  const valueClass =
    tint === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tint === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : tint === "purple"
          ? "text-purple-600 dark:text-purple-400"
          : "text-foreground";
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
      <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("truncate text-xs font-semibold tabular-nums", valueClass)}>
        {children}
      </p>
    </div>
  );
}
