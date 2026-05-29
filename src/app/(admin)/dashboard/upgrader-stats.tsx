import {
  TrendingUp,
  TrendingDown,
  Coins,
  HandCoins,
  Percent,
  Hash,
  Sigma,
  Users,
  Trophy,
  X,
  Target,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/animated-number";
import { formatNumber } from "@/lib/utils/format";
import type { UpgraderStats } from "@/lib/queries/dashboard-upgrader";

/**
 * Dedicated Upgrader stats section between the KPI strips and the
 * Trends graphs. Lifetime-only after the perf pass — the period chip
 * selector that used to drive a 9-window CASE-WHEN scan was removed in
 * favor of a single lifetime aggregate. The underlying query is also
 * 5-minute cross-request cached so the section costs ~0 on the
 * dashboard's 60s refresh cycle.
 *
 * Server component now (no `"use client"`) — the only client behaviour
 * was the period selector, and that's gone.
 */
export function UpgraderStatsSection({
  stats,
}: {
  stats: UpgraderStats;
}) {
  // House-POV color for the P&L tile: positive = house gained
  // (emerald), negative = house lost (rose). Matches the dashboard's
  // PnL StatCard convention.
  const pnlPositive = stats.pnl >= 0;
  const pnlColor = pnlPositive
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const PnlIcon = pnlPositive ? TrendingUp : TrendingDown;
  // Edge can also go negative if payouts exceeded wagers (variance).
  // Same color rule.
  const edgePositive = stats.edge >= 0;
  const edgeColor = edgePositive
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";

  return (
    <Card className="bg-cyan-500/5 border-cyan-500/20">
      <CardContent className="space-y-4 p-4 sm:p-5">
        {/* Header: title + scope chip. No period selector — this is
            lifetime only after the perf pass. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-500">
              <TrendingUp className="size-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold leading-tight">
                Upgrader Stats
              </h3>
              <p className="text-[11px] text-muted-foreground">
                Lifetime · raw customer signal — staff and creators excluded
              </p>
            </div>
          </div>
        </div>

        {/* Tile grid. 2-up on phones, 5-up on md, 10-up on xl so each
            tile keeps a readable hero number on every viewport. */}
        <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-5 xl:grid-cols-10">
          <UpgraderTile
            icon={Coins}
            label="Wager"
            value={stats.wager}
            format="currency"
            accent="cyan"
          />
          <UpgraderTile
            icon={HandCoins}
            label="Payouts"
            value={stats.payouts}
            format="currency"
            accent="rose"
          />
          <UpgraderTile
            icon={PnlIcon}
            label="House P&L"
            value={stats.pnl}
            format="currency"
            valueClassName={pnlColor}
            sign={pnlPositive ? "+" : "−"}
            // Render absolute so the sign is explicit instead of
            // formatCurrency's parenthesis trick.
            absolute
          />
          <UpgraderTile
            icon={Percent}
            label="House Edge"
            value={stats.edge}
            format="percent"
            valueClassName={edgeColor}
          />
          <UpgraderTile
            icon={Hash}
            label="Bets"
            value={stats.bets}
            format="number"
          />
          <UpgraderTile
            icon={Sigma}
            label="Avg Bet"
            value={stats.avgBet}
            format="currency"
          />
          <UpgraderTile
            icon={Users}
            label="Unique Players"
            value={stats.uniquePlayers}
            format="number"
          />
          {/* Outcome split — wins (user hit) / losses (user missed) /
              hit rate. House-POV colors: every win is house loss
              (rose), every loss is house gain (emerald). Hit rate is
              neutral since the colour would just duplicate Wins. */}
          <UpgraderTile
            icon={Trophy}
            label="Wins"
            value={stats.wins}
            format="number"
            accent="rose"
            valueClassName="text-rose-600 dark:text-rose-400"
          />
          <UpgraderTile
            icon={X}
            label="Losses"
            value={stats.losses}
            format="number"
            accent="cyan"
            valueClassName="text-emerald-600 dark:text-emerald-400"
          />
          <UpgraderTile
            icon={Target}
            label="Hit Rate"
            value={stats.hitRate}
            format="percent"
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Compact stat tile used inside the Upgrader section. Smaller than the
 * dashboard's main StatCard — this row has 10 tiles, so each one
 * carries less hero presence and relies on the section card around it
 * to read as a coherent unit.
 */
function UpgraderTile({
  icon: Icon,
  label,
  value,
  format,
  accent = "neutral",
  valueClassName,
  sign,
  absolute,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  format: "currency" | "number" | "percent";
  accent?: "cyan" | "rose" | "neutral";
  valueClassName?: string;
  sign?: string;
  absolute?: boolean;
}) {
  const accentClass =
    accent === "cyan"
      ? "bg-cyan-500/15 text-cyan-500"
      : accent === "rose"
        ? "bg-rose-500/15 text-rose-500"
        : "bg-muted text-muted-foreground";
  const display = absolute ? Math.abs(value) : value;
  return (
    <div className="rounded-lg border bg-background/40 px-3 py-2.5 min-w-0">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md",
            accentClass,
          )}
        >
          <Icon className="size-3" />
        </span>
        <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
      </div>
      <p
        className={cn(
          "mt-1.5 truncate text-base font-semibold tabular-nums",
          valueClassName,
        )}
      >
        {sign}
        {format === "currency" ? (
          <AnimatedNumber value={display} format="currency" />
        ) : format === "percent" ? (
          <AnimatedNumber value={display} format="percent" />
        ) : (
          formatNumber(display)
        )}
      </p>
    </div>
  );
}
