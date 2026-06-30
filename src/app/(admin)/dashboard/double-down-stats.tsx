import {
  TrendingUp,
  TrendingDown,
  Coins,
  HandCoins,
  Percent,
  Hash,
  Users,
  Trophy,
  X,
  Target,
  Dices,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/animated-number";
import { formatNumber } from "@/lib/utils/format";
import type { DoubleDownDashboardStats } from "@/lib/queries/double-down";

/**
 * Dashboard Double Down stats panel — mirrors the Upgrader Stats panel's
 * layout + half-width slot so the two read as one family. Lifetime aggregate
 * (period-independent), counted the DEV's canonical way: game_sessions of
 * game_type 'battle_double_down' JOINed to battle_double_down_offers (= PLAYED
 * rounds), with win payout / house edge read strictly from the paired payout
 * voucher (no ledger/balance derivation).
 *
 * House-POV colors (CLAUDE.md, STRICT):
 *   - Net House P&L positive = house up → emerald; negative → rose.
 *   - Forfeited (a player LOSE) = house gain → emerald.
 *   - Paid out (a player WIN) = house cost → rose.
 *   - Win-rate band: a player win is a house loss → rose; a loss → emerald
 *     (same flip the Upgrader panel uses).
 *
 * Server component — no client interactivity (matches the Upgrader panel).
 */
export function DoubleDownStatsSection({
  stats,
}: {
  stats: DoubleDownDashboardStats;
}) {
  const pnlPositive = stats.netHousePnl >= 0;
  const pnlColor = pnlPositive
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const pnlBg = pnlPositive
    ? "from-emerald-500/15 via-emerald-500/5 to-transparent"
    : "from-rose-500/15 via-rose-500/5 to-transparent";
  const PnlIcon = pnlPositive ? TrendingUp : TrendingDown;

  const edgePct = (stats.houseEdgePct ?? 0) * 100;
  const edgePositive = edgePct >= 0;
  const edgeColor = edgePositive
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const edgeBg = edgePositive
    ? "from-emerald-500/15 via-emerald-500/5 to-transparent"
    : "from-rose-500/15 via-rose-500/5 to-transparent";

  // Player win-rate (= house loss-rate). Clamp [0,100].
  const winRatePct = (stats.winRate ?? 0) * 100;
  const winRateClamped = Math.max(0, Math.min(100, winRatePct));

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

        {/* Hero row — Net House P&L + House Edge. */}
        <div className="grid grid-cols-2 gap-3">
          <HeroCard
            label="House P&L"
            icon={PnlIcon}
            colorClass={pnlColor}
            gradientClass={pnlBg}
            sign={pnlPositive ? "+" : "−"}
          >
            <AnimatedNumber value={Math.abs(stats.netHousePnl)} format="currency" />
          </HeroCard>
          <HeroCard
            label="House Edge"
            icon={Percent}
            colorClass={edgeColor}
            gradientClass={edgeBg}
          >
            <AnimatedNumber value={edgePct} format="percent" />
          </HeroCard>
        </div>

        {/* Volume row — Forfeited (house gain) vs Paid out (house cost). */}
        <div className="grid grid-cols-2 gap-3">
          <SubCard
            icon={Coins}
            label="Forfeited"
            accentClass="bg-emerald-500/15 text-emerald-500"
            valueClass="text-emerald-600 dark:text-emerald-400"
          >
            <AnimatedNumber value={stats.forfeited} format="currency" />
          </SubCard>
          <SubCard
            icon={HandCoins}
            label="Paid out"
            accentClass="bg-rose-500/15 text-rose-500"
            valueClass="text-rose-600 dark:text-rose-400"
          >
            <AnimatedNumber value={stats.paidOut} format="currency" />
          </SubCard>
        </div>

        {/* Activity row — Rounds / Staked / Players. */}
        <div className="grid grid-cols-3 gap-2">
          <MicroCard icon={Hash} label="Rounds">
            {formatNumber(stats.rounds)}
          </MicroCard>
          <MicroCard icon={Coins} label="Staked">
            <AnimatedNumber value={stats.staked} format="currency" />
          </MicroCard>
          <MicroCard icon={Users} label="Players">
            {formatNumber(stats.uniquePlayers)}
          </MicroCard>
        </div>

        {/* Win-rate band — player win% (= house loss%). House-POV flip:
            player wins (rose) / player losses (emerald). */}
        <div className="mt-auto rounded-xl border bg-background/40 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <Target className="size-3.5 text-purple-500" />
              Win Rate
            </div>
            <span className="font-mono text-sm font-semibold tabular-nums">
              {stats.winRate === null ? "—" : `${winRatePct.toFixed(1)}%`}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-emerald-500/15">
            <div
              className="h-full rounded-full bg-gradient-to-r from-rose-500 to-rose-400 transition-all"
              style={{ width: `${winRateClamped}%` }}
              aria-hidden
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
              <Trophy className="size-3" />
              Wins{" "}
              <span className="font-mono font-semibold tabular-nums">
                {formatNumber(stats.wins)}
              </span>
            </span>
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <X className="size-3" />
              Loses{" "}
              <span className="font-mono font-semibold tabular-nums">
                {formatNumber(stats.loses)}
              </span>
            </span>
          </div>
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
    <div className="rounded-lg border bg-background/30 px-2.5 py-1.5 min-w-0">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3 shrink-0 text-purple-500/80" />
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-0.5 truncate text-sm font-semibold tabular-nums">
        {children}
      </p>
    </div>
  );
}
