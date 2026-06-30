import {
  TrendingUp,
  TrendingDown,
  Coins,
  Hash,
  Trophy,
  Dices,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/animated-number";
import { formatNumber } from "@/lib/utils/format";
import type { DoubleDownDashboardStats } from "@/lib/queries/double-down";

/**
 * Dashboard Double Down stats panel — EXACTLY four metrics (owner rule,
 * 2026-06-30): House P&L · Win rate · Started rounds · Total wager. Lifetime
 * aggregate (period-independent), counted the DEV's canonical way:
 * game_sessions of game_type 'battle_double_down' JOINed to
 * battle_double_down_offers (= PLAYED/started rounds), with win payout read
 * strictly from the paired payout voucher (no ledger/balance derivation).
 *
 * House P&L = the headline "did WE make money": net house P&L = forfeited −
 * payouts (paidOut/forfeited stay computed internally to derive it, but are
 * NOT shown as their own tiles). House-POV color: site PROFIT (≥0) →
 * emerald, site LOSS (<0) → rose, with sign + profit/loss label. Win rate is
 * neutral (purple, matches the panel accent).
 *
 * Server component — no client interactivity (matches the Upgrader panel).
 */
export function DoubleDownStatsSection({
  stats,
}: {
  stats: DoubleDownDashboardStats;
}) {
  const houseProfit = stats.netHousePnl >= 0;
  const pnlColor = houseProfit
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const pnlBg = houseProfit
    ? "from-emerald-500/15 via-emerald-500/5 to-transparent"
    : "from-rose-500/15 via-rose-500/5 to-transparent";
  const PnlIcon = houseProfit ? TrendingUp : TrendingDown;

  const winRatePct = (stats.winRate ?? 0) * 100;

  return (
    <Card className="relative h-full overflow-hidden border-purple-500/20 bg-gradient-to-br from-purple-500/5 via-card to-card">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-purple-500/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-12 -bottom-12 size-40 rounded-full bg-purple-500/10 blur-3xl"
      />

      <div className="relative flex h-full flex-col gap-3 p-3 sm:p-4">
        {/* Header — title + lifetime scope chip. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-500 ring-1 ring-inset ring-purple-500/20">
              <Dices className="size-3.5" />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold leading-tight">
                Double Down
              </h3>
              <p className="truncate text-[11px] text-muted-foreground">
                Lifetime · gamble-your-winnings rounds
              </p>
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400">
            All time
          </span>
        </div>

        {/* Hero row — House P&L (did WE make money?) + Win rate. */}
        <div className="grid grid-cols-2 gap-3">
          <HeroCard
            label={houseProfit ? "House P&L · profit" : "House P&L · loss"}
            icon={PnlIcon}
            colorClass={pnlColor}
            gradientClass={pnlBg}
            sign={houseProfit ? "+" : "−"}
          >
            <AnimatedNumber value={Math.abs(stats.netHousePnl)} format="currency" />
          </HeroCard>
          <HeroCard
            label="Win rate"
            icon={Trophy}
            colorClass="text-purple-600 dark:text-purple-400"
            gradientClass="from-purple-500/15 via-purple-500/5 to-transparent"
          >
            {stats.winRate === null ? "—" : `${winRatePct.toFixed(1)}%`}
          </HeroCard>
        </div>

        {/* Volume row — Started rounds + Total wager. */}
        <div className="mt-auto grid grid-cols-2 gap-3">
          <SubCard
            icon={Hash}
            label="Started rounds"
            accentClass="bg-purple-500/15 text-purple-500"
            valueClass="text-foreground"
          >
            {formatNumber(stats.rounds)}
          </SubCard>
          <SubCard
            icon={Coins}
            label="Total wager"
            accentClass="bg-purple-500/15 text-purple-500"
            valueClass="text-foreground"
          >
            <AnimatedNumber value={stats.staked} format="currency" />
          </SubCard>
        </div>
      </div>
    </Card>
  );
}

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
        "relative overflow-hidden rounded-xl border bg-gradient-to-br px-3 py-2.5",
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
          "mt-1 truncate text-lg font-bold tabular-nums sm:text-xl",
          colorClass,
        )}
      >
        {sign}
        {children}
      </p>
    </div>
  );
}

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
    <div className="rounded-xl border bg-background/40 px-3 py-2">
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
          "mt-1 truncate text-sm font-semibold tabular-nums",
          valueClass,
        )}
      >
        {children}
      </p>
    </div>
  );
}
