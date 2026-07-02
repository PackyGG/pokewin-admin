import Link from "next/link";
import { Zap, Dices, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/animated-number";
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
 * both removed) were full-width 50/50-row panels with a hero/volume/
 * activity/hit-rate layout — far too tall for a Today-row tile. This merge
 * intentionally condenses each side down to its ONE headline number (House
 * P&L, House-POV signed) plus a small secondary rate chip (House Edge /
 * Win rate), mirroring the Deposits/Withdrawals merged tile's "two stacked
 * halves + hairline divider" shape. The dropped detail (wager, payouts,
 * bets, avg bet, players, rounds staked) is one click away via the "View
 * details" link on each half — the Upgrader catalog page (`/upgrader`) and
 * the Double Down insights page (`/insights/double-down`) both still carry
 * the full breakdown.
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
  upgrader: Pick<UpgraderStats, "pnl" | "edge">;
  doubleDown: Pick<DoubleDownDashboardStats, "netHousePnl" | "winRate">;
}) {
  const upgraderProfit = upgrader.pnl >= 0;
  const upgraderColor = upgraderProfit
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";

  const ddProfit = doubleDown.netHousePnl >= 0;
  const ddColor = ddProfit
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const ddWinRatePct =
    doubleDown.winRate === null ? null : doubleDown.winRate * 100;

  return (
    <Card className="bg-cyan-500/5">
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
            <span className="shrink-0 rounded-full bg-cyan-500/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-cyan-600 dark:text-cyan-400">
              {upgrader.edge.toFixed(1)}% edge
            </span>
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
        </div>

        <div className="border-t border-border/50" />

        {/* Double Down half. */}
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400">
              <Dices className="size-3 shrink-0" />
              <span className="truncate">Double Down</span>
            </p>
            <span className="shrink-0 rounded-full bg-purple-500/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-purple-600 dark:text-purple-400">
              {ddWinRatePct === null ? "—" : `${ddWinRatePct.toFixed(1)}%`} win rate
            </span>
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
        </div>
      </CardContent>
    </Card>
  );
}
