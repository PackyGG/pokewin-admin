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
  Zap,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/animated-number";
import { formatNumber, formatCurrency } from "@/lib/utils/format";
import type { UpgraderStats } from "@/lib/queries/dashboard-upgrader";

/**
 * Dedicated Upgrader stats section, paired 50/50 with the Wager
 * Attribution chart between the KPI strips and the Trends grid.
 * Lifetime-only after the perf pass — the period chip selector that
 * used to drive a 9-window CASE-WHEN scan was removed in favor of a
 * single lifetime aggregate. The underlying query is also 5-minute
 * cross-request cached so the section costs ~0 on the dashboard's
 * 60s refresh cycle.
 *
 * Designed for the half-width slot it now lives in (≈600–700px on
 * lg+, full-width on phone). The previous 10-up-on-xl tile row was
 * built for a full-width container and crushed badly when the panel
 * moved next to the Wager Attribution chart. The new layout:
 *   • Header strip (icon + title + scope chip).
 *   • Hero row: House P&L + House Edge — the two numbers an operator
 *     opens this section to read.
 *   • Volume row: Wager + Payouts.
 *   • Activity row: Bets + Avg Bet + Unique Players (compact 3-up).
 *   • Hit Rate band: progress bar plus the Wins / Losses split.
 *
 * Server component — no client interactivity remains after the
 * period selector was dropped.
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
  const pnlBg = pnlPositive
    ? "from-emerald-500/15 via-emerald-500/5 to-transparent"
    : "from-rose-500/15 via-rose-500/5 to-transparent";
  const PnlIcon = pnlPositive ? TrendingUp : TrendingDown;
  // Edge can also go negative if payouts exceeded wagers (variance).
  // Same color rule.
  const edgePositive = stats.edge >= 0;
  const edgeColor = edgePositive
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const edgeBg = edgePositive
    ? "from-emerald-500/15 via-emerald-500/5 to-transparent"
    : "from-rose-500/15 via-rose-500/5 to-transparent";

  // Hit-rate visualization. Clamp to [0, 100] so a rounding overshoot
  // doesn't push the bar off the right edge.
  const hitRateClamped = Math.max(0, Math.min(100, stats.hitRate));

  return (
    <Card className="relative h-full overflow-hidden border-cyan-500/20 bg-gradient-to-br from-cyan-500/5 via-card to-card">
      {/* Corner glows mirror the modern-panels aesthetic from the
          user-detail page — two soft blurred circles in the accent
          color so the panel feels alive instead of being a flat box. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-cyan-500/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-12 -bottom-12 size-40 rounded-full bg-cyan-500/10 blur-3xl"
      />

      <div className="relative flex h-full flex-col gap-4 p-4 sm:p-5">
        {/* Header — title + lifetime scope chip. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-500 ring-1 ring-inset ring-cyan-500/20">
              <Zap className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold leading-tight">
                Upgrader Stats
              </h3>
              <p className="truncate text-[11px] text-muted-foreground">
                Lifetime · raw customer signal
              </p>
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
            All time
          </span>
        </div>

        {/* Hero row — House P&L and House Edge. The two numbers
            operators open this section to read. Larger hero
            typography and tinted backgrounds so they read first. */}
        <div className="grid grid-cols-2 gap-3">
          <HeroCard
            label="House P&L"
            icon={PnlIcon}
            colorClass={pnlColor}
            gradientClass={pnlBg}
            sign={pnlPositive ? "+" : "−"}
          >
            <AnimatedNumber
              value={Math.abs(stats.pnl)}
              format="currency"
            />
          </HeroCard>
          <HeroCard
            label="House Edge"
            icon={Percent}
            colorClass={edgeColor}
            gradientClass={edgeBg}
          >
            <AnimatedNumber value={stats.edge} format="percent" />
          </HeroCard>
        </div>

        {/* Volume row — total Wager vs total Payouts. Two compact
            cards split 50/50; the arrow icons reinforce the "money
            in vs money out" semantic. */}
        <div className="grid grid-cols-2 gap-3">
          <SubCard
            icon={Coins}
            label="Wager"
            accentClass="bg-emerald-500/15 text-emerald-500"
            valueClass="text-emerald-600 dark:text-emerald-400"
          >
            <AnimatedNumber value={stats.wager} format="currency" />
          </SubCard>
          <SubCard
            icon={HandCoins}
            label="Payouts"
            accentClass="bg-rose-500/15 text-rose-500"
            valueClass="text-rose-600 dark:text-rose-400"
          >
            <AnimatedNumber value={stats.payouts} format="currency" />
          </SubCard>
        </div>

        {/* Activity row — Bets / Avg Bet / Unique Players. Three
            compact stats; the grid stays 3-up even at narrow widths
            so the row reads as a single density unit. */}
        <div className="grid grid-cols-3 gap-2">
          <MicroCard icon={Hash} label="Bets">
            {formatNumber(stats.bets)}
          </MicroCard>
          <MicroCard icon={Sigma} label="Avg Bet">
            {formatCurrency(stats.avgBet)}
          </MicroCard>
          <MicroCard icon={Users} label="Players">
            {formatNumber(stats.uniquePlayers)}
          </MicroCard>
        </div>

        {/* Hit Rate band — progress bar + wins/losses breakdown.
            House-POV color rule: every player win is a house loss
            (rose); every player loss is a house gain (emerald). The
            bar visualises win% directly so an admin can eyeball the
            ratio without reading the digits. */}
        <div className="mt-auto rounded-xl border bg-background/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <Target className="size-3.5 text-cyan-500" />
              Hit Rate
            </div>
            <span className="font-mono text-sm font-semibold tabular-nums">
              {stats.hitRate.toFixed(1)}%
            </span>
          </div>
          {/* Progress bar — wins (rose) / losses (emerald). House-POV
              flip means a "good" hit rate for the user is bad for the
              house, so the colors swap from the conventional
              "good = green" mapping. */}
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-emerald-500/15">
            <div
              className="h-full rounded-full bg-gradient-to-r from-rose-500 to-rose-400 transition-all"
              style={{ width: `${hitRateClamped}%` }}
              aria-hidden
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
              <Trophy className="size-3" />
              Wins{" "}
              <span className="font-mono font-semibold tabular-nums">
                {formatNumber(stats.wins)}
              </span>
            </span>
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <X className="size-3" />
              Losses{" "}
              <span className="font-mono font-semibold tabular-nums">
                {formatNumber(stats.losses)}
              </span>
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Hero card — top-row, larger typography, gradient tint behind the
 * value to lift it visually. Used for the two headline stats
 * operators read first: P&L and Edge.
 */
function HeroCard({
  label,
  icon: Icon,
  colorClass,
  gradientClass,
  sign,
  children,
}: {
  label: string;
  icon: React.ElementType;
  colorClass: string;
  gradientClass: string;
  sign?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border bg-gradient-to-br p-3",
        gradientClass,
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3.5", colorClass)} />
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
      </div>
      <p
        className={cn(
          "mt-1.5 truncate text-xl font-bold tabular-nums sm:text-2xl",
          colorClass,
        )}
      >
        {sign}
        {children}
      </p>
    </div>
  );
}

/**
 * Sub card — mid-row, medium typography, used for the Wager /
 * Payouts breakdown. Accent dot matches the house-POV color so the
 * two cards read as a paired "in vs out" row.
 */
function SubCard({
  icon: Icon,
  label,
  accentClass,
  valueClass,
  children,
}: {
  icon: React.ElementType;
  label: string;
  accentClass: string;
  valueClass: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-background/40 p-3">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md",
            accentClass,
          )}
        >
          <Icon className="size-3" />
        </span>
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
      </div>
      <p
        className={cn(
          "mt-1.5 truncate text-base font-semibold tabular-nums",
          valueClass,
        )}
      >
        {children}
      </p>
    </div>
  );
}

/**
 * Micro card — bottom row, compact 3-up density. Tiny icon, tiny
 * label, mid-size value. Used for activity stats (Bets / Avg Bet /
 * Players) which carry secondary importance.
 */
function MicroCard({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-background/30 px-2.5 py-2 min-w-0">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3 shrink-0 text-cyan-500/80" />
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums">
        {children}
      </p>
    </div>
  );
}
