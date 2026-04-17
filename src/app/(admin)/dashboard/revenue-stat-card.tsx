"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { AnimatedNumber } from "@/components/animated-number";

const ranges = ["24h", "3d", "7d", "30d", "all"] as const;

// Lifetime realized P&L — a single snapshot number, not period-based. The
// number comes straight from getRealizedPnlSnapshot() in the dashboard query and
// already accounts for deposits, withdrawals, user balances, inventory,
// unclaimed vouchers, and unclaimed rakeback. No range selector — adding one
// would be misleading because the underlying liabilities are current-state,
// not a time series.
//
// Colors follow CLAUDE.md's house-POV rule: house profit = emerald, house
// loss = rose. Uses the rose palette rather than red so the dashboard keeps
// a single-tone "house loss" color across every card.
export function PnlStatCard({ pnl }: { pnl: number }) {
  const isProfit = pnl >= 0;

  return (
    <Card className={cn(isProfit ? "bg-emerald-500/10" : "bg-rose-500/10")}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-card-title text-muted-foreground">
            PnL
          </CardTitle>
          <span className="text-tiny text-muted-foreground">lifetime</span>
        </div>
        {isProfit ? (
          <TrendingUp className="size-4 text-emerald-400" />
        ) : (
          <TrendingDown className="size-4 text-rose-400" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-stat-value">
          <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
            {isProfit ? "+" : ""}
            <AnimatedNumber value={pnl} format="currency" />
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
// Colors: house-POV. Positive GGR (we made money on gameplay) = emerald,
// negative GGR (users net-won against us in the period) = rose.
export function GgrStatCard({ ggr }: { ggr: Record<string, number> }) {
  const [selected, setSelected] = useState<string>("24h");
  const value = ggr[selected] ?? 0;
  const isProfit = value >= 0;

  return (
    <Card className={cn(isProfit ? "bg-emerald-500/10" : "bg-rose-500/10")}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-card-title text-muted-foreground">
            GGR
          </CardTitle>
          <div className="flex gap-0.5">
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => setSelected(r)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
                  selected === r
                    ? isProfit
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        {isProfit ? (
          <TrendingUp className="size-4 text-emerald-400" />
        ) : (
          <TrendingDown className="size-4 text-rose-400" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-stat-value">
          <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
            {isProfit ? "+" : ""}
            <AnimatedNumber value={value} format="currency" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// Wagers = money the user sent into the house treasury for a bet. House
// gain by definition, so the card tracks the emerald accent even though
// wagers are always positive (no direction flip needed).
export function WagerStatCard({
  wagers,
}: {
  wagers: Record<string, number>;
}) {
  const [selected, setSelected] = useState<string>("24h");

  return (
    <Card className="bg-emerald-500/10">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-card-title text-muted-foreground">
            Total Wager
          </CardTitle>
          <div className="flex gap-0.5">
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
        <div className="text-stat-value">
          <AnimatedNumber
            value={wagers[selected] ?? 0}
            format="currency"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// Deposits = fresh cash flowing into the house. House gain → emerald.
export function DepositsStatCard({
  deposits,
}: {
  deposits: Record<string, number>;
}) {
  const [selected, setSelected] = useState<string>("24h");

  return (
    <Card className="bg-emerald-500/10">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-card-title text-muted-foreground">
            Deposits
          </CardTitle>
          <div className="flex gap-0.5">
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
        <div className="text-stat-value">
          <AnimatedNumber
            value={deposits[selected] ?? 0}
            format="currency"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// Crypto + card withdrawals totalled per period. Shares the Deposits card's
// range selector (24h / 3d / 7d / 30d / all) so an admin can compare net
// flow at a glance.
export function WithdrawalsStatCard({
  withdrawals,
}: {
  withdrawals: Record<string, number>;
}) {
  const [selected, setSelected] = useState<string>("24h");

  return (
    <Card className="bg-rose-500/10">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-card-title text-muted-foreground">
            Withdrawals
          </CardTitle>
          <div className="flex gap-0.5">
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => setSelected(r)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
                  selected === r
                    ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
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
        <div className="text-stat-value">
          <AnimatedNumber
            value={withdrawals[selected] ?? 0}
            format="currency"
          />
        </div>
      </CardContent>
    </Card>
  );
}
