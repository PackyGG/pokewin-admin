"use client";

import Link from "next/link";
import { LineChart, TrendingDown, TrendingUp } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CreatorLifetimePnlBreakdownRow } from "../_queries/all-creators-lifetime-pnl";

type Props = {
  creators: CreatorLifetimePnlBreakdownRow[];
};

/**
 * Drill-in popover for the Global PnL KPI tile. The trigger sits in
 * the tile's top-right `action` slot; hovering opens a per-creator
 * lifetime PnL breakdown so admins can immediately see which creator
 * is dragging the global number into the red (rows are server-sorted
 * by `pnl` ascending, so the worst-performing creator surfaces at
 * the top).
 *
 * Per-creator numbers use the same coverage-aware code attribution as
 * the /creators/[id] hero panel:
 *   • totalDeposits — ledger deposits attributed via 7-day coverage
 *     window of the user's most recent acu event.
 *   • totalCardWithdrawals — physical cards from creator-attributed
 *     sessions, filtered to coverage-depositors.
 *
 * Hover uses Base UI's built-in `openOnHover` + `closeDelay` — no
 * flicker as the cursor crosses the trigger→content gap.
 */
export function GlobalPnlByCreatorPopover({ creators }: Props) {
  if (creators.length === 0) {
    return null;
  }

  const losers = creators.filter((c) => c.pnl < 0).length;
  const winners = creators.filter((c) => c.pnl > 0).length;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={100}
        closeDelay={200}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors",
          "hover:border-foreground/30 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        aria-label="Show per-creator lifetime PnL breakdown"
      >
        <LineChart className="size-3" />
        {formatNumber(creators.length)}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[500px] max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <LineChart className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Lifetime PnL · {creators.length} creator
              {creators.length === 1 ? "" : "s"}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground/70">
            {losers > 0 && (
              <span className="text-rose-500">{losers}↓</span>
            )}
            {losers > 0 && winners > 0 && " · "}
            {winners > 0 && (
              <span className="text-emerald-500">{winners}↑</span>
            )}
          </span>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-popover">
              <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-1.5 text-left font-medium">Creator</th>
                <th className="px-2 py-1.5 text-right font-medium">Dep</th>
                <th className="px-2 py-1.5 text-right font-medium">Wagered</th>
                <th className="px-2 py-1.5 text-right font-medium">Card WD</th>
                <th className="px-3 py-1.5 text-right font-medium">PnL</th>
              </tr>
            </thead>
            <tbody>
              {creators.map((c) => {
                const isWin = c.pnl > 0;
                const isLoss = c.pnl < 0;
                const TrendIcon = isWin
                  ? TrendingUp
                  : isLoss
                    ? TrendingDown
                    : LineChart;
                return (
                  <tr
                    key={c.userId}
                    className="border-b border-border/30 last:border-0 hover:bg-muted/40"
                  >
                    <td className="px-3 py-1.5">
                      <Link
                        href={`/creators/${c.userId}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <Avatar className="size-5">
                          {c.image && <AvatarImage src={c.image} alt="" />}
                          <AvatarFallback className="text-[9px]">
                            {(c.username ?? "?").slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="max-w-[140px] truncate font-medium">
                          {c.username ?? "—"}
                        </span>
                        <TrendIcon
                          className={cn(
                            "size-3 shrink-0",
                            isWin
                              ? "text-emerald-500"
                              : isLoss
                                ? "text-rose-500"
                                : "text-muted-foreground/40",
                          )}
                        />
                      </Link>
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right tabular-nums",
                        c.totalDeposits > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground/60",
                      )}
                    >
                      {c.totalDeposits === 0
                        ? "—"
                        : formatCurrency(c.totalDeposits)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {c.totalWagered === 0
                        ? "—"
                        : formatCurrency(c.totalWagered)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right tabular-nums",
                        c.totalCardWithdrawals > 0
                          ? "text-rose-600 dark:text-rose-400"
                          : "text-muted-foreground/60",
                      )}
                    >
                      {c.totalCardWithdrawals === 0
                        ? "—"
                        : formatCurrency(c.totalCardWithdrawals)}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-1.5 text-right font-semibold tabular-nums",
                        isWin
                          ? "text-emerald-600 dark:text-emerald-400"
                          : isLoss
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-muted-foreground/60",
                      )}
                    >
                      {c.pnl === 0
                        ? "—"
                        : `${isWin ? "+" : ""}${formatCurrency(c.pnl)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </PopoverContent>
    </Popover>
  );
}
