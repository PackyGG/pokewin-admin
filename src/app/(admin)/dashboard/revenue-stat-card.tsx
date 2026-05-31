"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

/**
 * Period-aware stat cards used in the dashboard's primary KPI strip.
 *
 * As of the global-period-selector refactor these cards no longer carry
 * their own chip rows — the dashboard now has a single
 * `<DashboardPeriodSelector>` at the top of the page that drives a
 * `?period=` URL param, and the server computes only the selected
 * period's value. Each card receives the resolved scalar value plus a
 * `periodLabel` (e.g. "Last 24h") so the title strip explains what the
 * dollar number is scoped to.
 *
 * House-POV color rules per CLAUDE.md:
 *   • House profit (positive PnL / positive GGR / positive Edge) →
 *     emerald
 *   • House loss (negative)                                       → rose
 *   • Identity-only colors (Wager, Deposits, Withdrawals) are picked
 *     for visual distinction in the row — they don't carry house-POV
 *     semantics on their own.
 */

// House P&L with two modes behind a small toggle:
//   • lifetime — the realized-P&L SNAPSHOT (getRealizedPnlSnapshot):
//     deposits − withdrawals − user balances − inventory − unclaimed
//     vouchers − unclaimed rakeback, valued right now. Not a time series.
//   • period   — the ROLLING windowed delta for the SELECTED period
//     (was 24h-only before the global selector): the change in house
//     P&L over the chosen window. Different methodology from the
//     snapshot (no rakeback term), so it sits behind its own toggle
//     rather than pretending the snapshot is a time series.
//
// Colors follow CLAUDE.md's house-POV rule: house profit = emerald,
// house loss = rose. The card tint + value color flip with the SELECTED
// value, so switching to the period view recolors the card if the
// window was a loss.
export function PnlStatCard({
  pnl,
  pnlPeriod,
  periodLabel,
}: {
  pnl: number;
  pnlPeriod: number;
  // Friendly label for the period (e.g. "Last 24h", "Last 7 days").
  // Drives the toggle label so it reads as "lifetime / 24h" or
  // "lifetime / 7d" depending on the global selector.
  periodLabel: string;
}) {
  const [mode, setMode] = useState<"lifetime" | "period">("lifetime");
  const value = mode === "lifetime" ? pnl : pnlPeriod;
  const isProfit = value >= 0;

  return (
    <Card className={cn(isProfit ? "bg-emerald-500/10" : "bg-rose-500/10")}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            PnL
          </CardTitle>
          <div className="flex gap-0.5">
            {([
              { key: "lifetime" as const, label: "lifetime" },
              { key: "period" as const, label: periodLabel },
            ]).map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
                  mode === m.key
                    ? "bg-background/70 text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {isProfit ? (
          <TrendingUp className="size-4 shrink-0 text-emerald-400" />
        ) : (
          <TrendingDown className="size-4 shrink-0 text-rose-400" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
            {isProfit ? "+" : ""}
            <AnimatedNumber value={value} format="currency" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// Gaming margin (GGR = wagers − payouts) for the selected period. Keeps
// emerald/rose for sign so direction is readable at a glance. Card
// identity colour is cyan so it's visually distinct from the rest of
// the row.
export function GgrStatCard({
  ggr,
  periodLabel,
}: {
  ggr: number;
  periodLabel: string;
}) {
  const isProfit = ggr >= 0;
  return (
    <Card className="bg-cyan-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <CardTitle className="text-card-title text-muted-foreground">
            GGR
          </CardTitle>
          <span className="text-tiny text-muted-foreground">{periodLabel}</span>
        </div>
        {isProfit ? (
          <TrendingUp className="size-4 shrink-0 text-emerald-400" />
        ) : (
          <TrendingDown className="size-4 shrink-0 text-rose-400" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
            {isProfit ? "+" : ""}
            <AnimatedNumber value={ggr} format="currency" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// Wagers = money the user sent into the house treasury for a bet.
// Always positive, so we give it a purple identity color to differentiate
// from the other period cards (Deposits / GGR / PnL / Withdrawals).
//
// Reused for three cards on the dashboard: "Total Wager" (customer
// wager — wagers a creator made while live on a deal/stream are
// dropped, since that is house-funded "sponsored" balance), "Raw
// Wager" (includes them) and "Organic Wager" (no creator-code users).
// `caption` carries the muted hint that distinguishes them.
//
// `breakdown` (optional) drives the small Packs / Battles / Upgrader
// chip row at the bottom of the card. Only the "Total Wager" instance
// passes it today — the Raw / Organic variants skip the chips.
export function WagerStatCard({
  wager,
  periodLabel,
  title = "Total Wager",
  caption,
  breakdown,
}: {
  wager: number;
  periodLabel: string;
  title?: string;
  caption?: string;
  breakdown?: {
    packs: number;
    battles: number;
    upgrader: number;
  };
}) {
  return (
    <Card className="bg-purple-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            {title}
          </CardTitle>
          <span className="text-tiny text-muted-foreground">
            {periodLabel}
            {caption ? ` · ${caption}` : ""}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-stat-value truncate">
          <AnimatedNumber value={wager} format="currency" />
        </div>
        {breakdown && (
          // 3 chip-style mini-boxes — Packs · Battles · Upgrader — for
          // the SELECTED window. Each chip carries its own label and a
          // small dollar amount so admins can see at a glance where the
          // window's wager volume comes from.
          <div className="grid grid-cols-3 gap-1.5 -mx-0.5">
            <WagerSourceChip label="Packs" value={breakdown.packs} />
            <WagerSourceChip label="Battles" value={breakdown.battles} />
            <WagerSourceChip label="Upgrader" value={breakdown.upgrader} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Small chip showing one of the wager sources (Packs / Battles /
 * Upgrader) under the Total Wager card. Compact: a tiny uppercase
 * label and a dollar value, sized so 3 chips fit on a phone-width
 * card. Uses the same purple identity color as the parent card with a
 * weaker fill so the chips read as a "secondary" row.
 */
function WagerSourceChip({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md border border-purple-500/15 bg-background/40 px-2 py-1.5 min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className="text-xs font-semibold tabular-nums truncate">
        <AnimatedNumber value={value} format="currency" />
      </p>
    </div>
  );
}

// Deposits = fresh cash flowing into the house. House gain → emerald.
// Shows two stacked signals tied to the global period:
//   1) total deposit amount in USD (the primary hero number)
//   2) deposit count + avg deposit size for the SELECTED period —
//      `Y deposits · ~$Z avg`. Avg is derived inline from
//      `deposits / depositCount` (defends against divide-by-zero with
//      "—") so admins can read at a glance whether the window's volume
//      came from many small deposits or fewer large ones, scoped to
//      whichever chip is selected.
export function DepositsStatCard({
  deposits,
  depositCount,
  periodLabel,
}: {
  deposits: number;
  // Optional so call sites that just want the dollar figure can skip
  // the secondary line.
  depositCount?: number;
  periodLabel: string;
}) {
  // Period-aware average deposit size. Falls back to "—" on a zero-
  // count window so we never render "$NaN" or "$0 avg" misleadingly.
  const avgDeposit =
    typeof depositCount === "number" && depositCount > 0
      ? formatCurrency(deposits / depositCount)
      : "—";
  return (
    <Card className="bg-emerald-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <CardTitle className="text-card-title text-muted-foreground">
            Deposits
            {typeof depositCount === "number" && (
              // Inline transaction-count chip next to the title — keeps
              // the count visible even when the user scrolls past the
              // sub-line. Muted so it doesn't compete with the dollar
              // hero value. formatNumber gives "1,234" for big windows.
              <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">
                · {formatNumber(depositCount)}
              </span>
            )}
          </CardTitle>
          <span className="text-tiny text-muted-foreground">{periodLabel}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <AnimatedNumber value={deposits} format="currency" />
        </div>
        {typeof depositCount === "number" && (
          <p className="text-stat-label mt-0.5">
            <AnimatedNumber value={depositCount} format="number" />{" "}
            {depositCount === 1 ? "deposit" : "deposits"} · ~{avgDeposit} avg
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Crypto + card withdrawals totalled for the selected period. Uses a
// pink identity so it's visually distinct from the PnL card (which uses
// rose when negative). The semantic is still "money leaving the house"
// but the card color is purely an identity signal.
export function WithdrawalsStatCard({
  withdrawals,
  withdrawalCount,
  periodLabel,
}: {
  withdrawals: number;
  // Optional so callers that just want the dollar figure can skip the
  // title chip. Sourced from the same `withdrawals` CTE as the dollar
  // amount in `getDashboardStats`, so they always match.
  withdrawalCount?: number;
  periodLabel: string;
}) {
  return (
    <Card className="bg-pink-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <CardTitle className="text-card-title text-muted-foreground">
            Withdrawals
            {typeof withdrawalCount === "number" && (
              // Inline transaction-count chip — matches the Deposits
              // card so admins can compare flow counts at a glance
              // without reading the dollar amounts.
              <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">
                · {formatNumber(withdrawalCount)}
              </span>
            )}
          </CardTitle>
          <span className="text-tiny text-muted-foreground">{periodLabel}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <AnimatedNumber value={withdrawals} format="currency" />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Creator-only slice of the period withdrawal volume — how many of the
 * `Withdrawals` card's transactions came from users with role =
 * 'creator' (creator personal cash-outs).
 *
 * Hero number is the COUNT (the user explicitly asked for "how many"),
 * sub-line carries the dollar amount + period label so the card stays
 * proportionate to its siblings.
 *
 * Purple identity so it doesn't read like a competing total to the
 * neighbouring Withdrawals card (pink) — purple matches the Depositors
 * snapshot tile's "people behind the money" framing.
 */
export function CreatorWithdrawalsStatCard({
  count,
  amount,
  periodLabel,
}: {
  count: number;
  amount: number;
  periodLabel: string;
}) {
  return (
    <Card className="bg-purple-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <CardTitle className="text-card-title text-muted-foreground">
            Creator Withdrawals
          </CardTitle>
          <span className="text-tiny text-muted-foreground">{periodLabel}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <AnimatedNumber value={count} format="number" />
        </div>
        <p className="text-stat-label mt-0.5">
          <AnimatedNumber value={amount} format="currency" /> total
        </p>
      </CardContent>
    </Card>
  );
}
