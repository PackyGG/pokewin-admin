"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/animated-number";

// Chronological order — shortest window first so the chips read left-to-right
// as "right now → all time". 1h/3h/6h/12h were added on top of the original
// daily/multi-day buckets for spotting acute spikes (live tournament starting,
// rain-tip flood, etc.) without waiting for the 24h aggregate to move.
const ranges = ["1h", "3h", "6h", "12h", "24h", "3d", "7d", "30d", "all"] as const;

// House P&L with two modes behind a small toggle:
//   • lifetime — the realized-P&L SNAPSHOT (getRealizedPnlSnapshot):
//     deposits − withdrawals − user balances − inventory − unclaimed
//     vouchers − unclaimed rakeback, valued right now. Not a time series.
//   • 24h — the ROLLING past-24h windowed delta (calculateWindowedPnl):
//     the change in house P&L over the last 24 hours (now − 24h, not
//     since UTC midnight). Different methodology from the snapshot (no
//     rakeback term), so it sits behind its own toggle rather than
//     pretending the snapshot is a time series.
//
// Colors follow CLAUDE.md's house-POV rule: house profit = emerald, house
// loss = rose. The card tint + value color flip with the SELECTED value,
// so switching to 24h recolors the card if the last day was a loss.
export function PnlStatCard({
  pnl,
  pnl24h,
}: {
  pnl: number;
  pnl24h: number;
}) {
  const [mode, setMode] = useState<"lifetime" | "24h">("lifetime");
  const value = mode === "lifetime" ? pnl : pnl24h;
  const isProfit = value >= 0;

  return (
    <Card className={cn(isProfit ? "bg-emerald-500/10" : "bg-rose-500/10")}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            PnL
          </CardTitle>
          <div className="flex gap-0.5">
            {(["lifetime", "24h"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
                  mode === m
                    ? "bg-background/70 text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m}
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

// Gaming margin (GGR = wagers − payouts) per period. Keeps the range selector
// because GGR is inherently a time-window metric, unlike realized P&L which
// is a balance-sheet snapshot.
//
// Card identity color is cyan so this card is visually distinct from the
// other period-aware cards. The NUMBER itself still flips emerald/rose by
// sign so direction is readable at a glance.
//
// Mobile layout: title + icon on row 1, period chips wrap onto their own
// row (`flex-wrap gap-1`) so 5 chips never bleed off the right edge of
// a 360px-wide card. At sm+ the original side-by-side layout returns.
export function GgrStatCard({ ggr }: { ggr: Record<string, number> }) {
  const [selected, setSelected] = useState<string>("24h");
  const value = ggr[selected] ?? 0;
  const isProfit = value >= 0;

  return (
    <Card className="bg-cyan-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            GGR
          </CardTitle>
          <div className="flex flex-wrap gap-0.5">
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => setSelected(r)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
                  selected === r
                    ? "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r}
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

// Wagers = money the user sent into the house treasury for a bet.
// Always positive, so we give it a purple identity color to differentiate
// from the other period cards (Deposits/GGR/PnL/Withdrawals).
//
// Reused for two cards on the dashboard: the default "Total Wager"
// (customer wager — wagers a creator made while live on a deal/stream
// are dropped, since that is house-funded "sponsored" balance) and a
// "Raw Wager" variant that includes them. `caption` carries the muted
// hint that distinguishes the pair.
//
// `breakdown` (optional) drives the small Packs / Battles / Upgrader
// chip row at the bottom of the card. Only the "Total Wager" instance
// passes it today — the Raw Wager variant skips the chips. Upgrader
// stays 0 until that product surface ships on the main site.
export function WagerStatCard({
  wagers,
  title = "Total Wager",
  caption,
  breakdown,
}: {
  wagers: Record<string, number>;
  title?: string;
  caption?: string;
  breakdown?: {
    packs: Record<string, number>;
    battles: Record<string, number>;
    upgrader: Record<string, number>;
  };
}) {
  const [selected, setSelected] = useState<string>("24h");

  return (
    <Card className="bg-purple-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            {title}
          </CardTitle>
          {caption && (
            <span className="hidden text-tiny text-muted-foreground sm:inline">
              {caption}
            </span>
          )}
          <div className="flex flex-wrap gap-0.5">
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => setSelected(r)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
                  selected === r
                    ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-stat-value truncate">
          <AnimatedNumber
            value={wagers[selected] ?? 0}
            format="currency"
          />
        </div>
        {breakdown && (
          // 3 chip-style mini-boxes — Packs · Battles · Upgrader — for
          // the SELECTED window. Each chip carries its own label and a
          // small dollar amount so admins can see at a glance where the
          // window's wager volume comes from. Mobile: stacks 3-up at
          // ≥ 360px (the cards already enforce a min-width that fits
          // three lean chips in a row).
          <div className="grid grid-cols-3 gap-1.5 -mx-0.5">
            <WagerSourceChip
              label="Packs"
              value={breakdown.packs[selected] ?? 0}
            />
            <WagerSourceChip
              label="Battles"
              value={breakdown.battles[selected] ?? 0}
            />
            <WagerSourceChip
              label="Upgrader"
              value={breakdown.upgrader[selected] ?? 0}
            />
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
// Shows two stacked signals tied to the same period selector:
//   1) total deposit amount in USD (the primary hero number)
//   2) deposit count (smaller, muted) — answers "how many deposits"
//      without needing a separate card. The two move together so the
//      admin can read off the average deposit at a glance.
export function DepositsStatCard({
  deposits,
  depositCounts,
}: {
  deposits: Record<string, number>;
  // Optional so existing call sites (or older snapshots in tests)
  // don't break if the counts aren't provided. When omitted we just
  // skip the secondary line.
  depositCounts?: Record<string, number>;
}) {
  const [selected, setSelected] = useState<string>("24h");
  const count = depositCounts?.[selected];

  return (
    <Card className="bg-emerald-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            Deposits
          </CardTitle>
          <div className="flex flex-wrap gap-0.5">
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => setSelected(r)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
                  selected === r
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <AnimatedNumber
            value={deposits[selected] ?? 0}
            format="currency"
          />
        </div>
        {typeof count === "number" && (
          <p className="text-stat-label mt-0.5">
            <AnimatedNumber value={count} format="number" />{" "}
            {count === 1 ? "deposit" : "deposits"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Crypto + card withdrawals totalled per period. Uses a pink identity so
// it's visually distinct from the PnL card (which uses rose when negative).
// The semantic is still "money leaving the house" but the card color is
// purely an identity signal.
export function WithdrawalsStatCard({
  withdrawals,
}: {
  withdrawals: Record<string, number>;
}) {
  const [selected, setSelected] = useState<string>("24h");

  return (
    <Card className="bg-pink-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            Withdrawals
          </CardTitle>
          <div className="flex flex-wrap gap-0.5">
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => setSelected(r)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
                  selected === r
                    ? "bg-pink-500/15 text-pink-600 dark:text-pink-400"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <AnimatedNumber
            value={withdrawals[selected] ?? 0}
            format="currency"
          />
        </div>
      </CardContent>
    </Card>
  );
}
