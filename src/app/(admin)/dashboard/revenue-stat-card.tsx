"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

const ranges = ["24h", "3d", "7d", "30d"] as const;

// Lifetime realized P&L — a single snapshot number, not period-based. The
// number comes straight from realizedPnlSnapshot() in the dashboard query and
// already accounts for deposits, withdrawals, user balances, inventory,
// unclaimed vouchers, and unclaimed rakeback. No range selector — adding one
// would be misleading because the underlying liabilities are current-state,
// not a time series.
export function PnlStatCard({ pnl }: { pnl: number }) {
  const isProfit = pnl >= 0;

  return (
    <Card className={cn(isProfit ? "bg-emerald-500/10" : "bg-red-500/10")}>
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
          <TrendingDown className="size-4 text-red-400" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-stat-value">
          <span className={isProfit ? "text-emerald-400" : "text-red-400"}>
            {isProfit ? "+" : ""}{formatCurrency(pnl)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// Gaming margin (GGR = wagers − payouts) per period. Keeps the range selector
// because GGR is inherently a time-window metric, unlike realized P&L which
// is a balance-sheet snapshot.
export function GgrStatCard({ ggr }: { ggr: Record<string, number> }) {
  const [selected, setSelected] = useState<string>("24h");
  const value = ggr[selected] ?? 0;
  const isProfit = value >= 0;

  return (
    <Card className={cn(isProfit ? "bg-sky-500/10" : "bg-red-500/10")}>
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
                      ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                      : "bg-red-500/15 text-red-600 dark:text-red-400"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        {isProfit ? (
          <TrendingUp className="size-4 text-sky-400" />
        ) : (
          <TrendingDown className="size-4 text-red-400" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-stat-value">
          <span className={isProfit ? "text-sky-400" : "text-red-400"}>
            {isProfit ? "+" : ""}{formatCurrency(value)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function WagerStatCard({
  wagers,
}: {
  wagers: Record<string, number>;
}) {
  const [selected, setSelected] = useState<string>("24h");

  return (
    <Card className="bg-pink-500/10">
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
        <div className="text-stat-value">
          {formatCurrency(wagers[selected] ?? 0)}
        </div>
      </CardContent>
    </Card>
  );
}
