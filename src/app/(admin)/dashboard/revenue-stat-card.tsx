"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

const ranges = ["24h", "3d", "7d", "30d"] as const;

export function PnlStatCard({
  pnl,
}: {
  pnl: Record<string, number>;
}) {
  const [selected, setSelected] = useState<string>("24h");
  const value = pnl[selected] ?? 0;
  const isProfit = value >= 0;

  return (
    <Card className={cn(isProfit ? "bg-emerald-500/10" : "bg-red-500/10")}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-card-title text-muted-foreground">
            PnL
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
          <TrendingUp className="size-4 text-emerald-400" />
        ) : (
          <TrendingDown className="size-4 text-red-400" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-stat-value">
          <span className={isProfit ? "text-emerald-400" : "text-red-400"}>
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
