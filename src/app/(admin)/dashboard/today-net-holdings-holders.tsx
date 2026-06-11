"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Loader2, Wallet } from "lucide-react";
import { AnimatedNumber } from "@/components/animated-number";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { fetchTodayNetHoldingsTopHolders } from "./today-net-holdings-actions";
import type { TodayNetHoldingsTopHolders } from "@/lib/queries/dashboard-today-net-holdings-movers";

/**
 * "Net holdings Δ" chip on the P&L Today tile with a lazy chevron
 * drilldown listing the top 5 users by |balanceΔ + inventoryΔ + voucherΔ|
 * today. Pattern mirrors reward-cost-race-claimants.tsx.
 */
export function TodayNetHoldingsHoldersChip({
  netHoldingsChange,
  tone,
  hint,
  className,
}: {
  netHoldingsChange: number;
  tone: "emerald" | "rose";
  hint?: string;
  className?: string;
}) {
  const [state, setState] = useState<{
    open: boolean;
    data: TodayNetHoldingsTopHolders | null;
    error: string | null;
  }>({ open: false, data: null, error: null });
  const [isPending, startTransition] = useTransition();

  const border =
    tone === "emerald" ? "border-emerald-500/15" : "border-rose-500/15";
  const valueColor =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";

  const handleToggle = () => {
    if (state.open) {
      setState((s) => ({ ...s, open: false }));
      return;
    }
    if (state.data) {
      setState((s) => ({ ...s, open: true }));
      return;
    }
    startTransition(async () => {
      try {
        const data = await fetchTodayNetHoldingsTopHolders();
        setState({ open: true, data, error: null });
      } catch (err) {
        setState({
          open: true,
          data: null,
          error:
            err instanceof Error ? err.message : "Failed to load top holders",
        });
      }
    });
  };

  return (
    <div className={cn("min-w-0", className)}>
      <div
        className={cn(
          "rounded-md border bg-background/40 px-2 py-1.5 min-w-0",
          border,
        )}
        title={hint}
      >
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
              Net holdings Δ
            </p>
            <p
              className={cn(
                "text-xs font-semibold tabular-nums truncate",
                valueColor,
              )}
            >
              <AnimatedNumber
                value={Math.abs(netHoldingsChange)}
                format="currency"
              />
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggle}
            disabled={isPending}
            aria-expanded={state.open}
            aria-label={
              state.open ? "Hide top holdings movers" : "Show top holdings movers"
            }
            title={state.open ? "Hide top holders" : "Show top 5 holders"}
            className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-60"
          >
            {isPending ? (
              <Loader2 className="size-3.5 motion-safe:animate-spin" />
            ) : (
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  state.open && "rotate-180",
                )}
              />
            )}
          </button>
        </div>
      </div>

      {state.open && (
        <div className="mt-1.5">
          {state.error ? (
            <p className="px-1 py-1.5 text-[10px] text-rose-400">
              {state.error}
            </p>
          ) : !state.data ? (
            <p className="px-1 py-1.5 text-[10px] text-muted-foreground">
              Loading…
            </p>
          ) : state.data.holders.length === 0 ? (
            <p className="px-1 py-1.5 text-[10px] text-muted-foreground">
              No net holdings movement today.
            </p>
          ) : (
            <ul className="divide-y divide-border/40 rounded border border-border/50">
              {state.data.holders.map((h) => {
                const username = h.username ?? `${h.userId.slice(0, 6)}…`;
                const up = h.netHoldingsChange > 0;
                const down = h.netHoldingsChange < 0;
                const sign = up ? "+" : down ? "−" : "";
                return (
                  <li key={h.userId}>
                    <Link
                      href={`/users/${h.userId}`}
                      className="flex items-center justify-between gap-2 px-1.5 py-1 text-[10px] transition-colors hover:bg-muted/50"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                          <Wallet className="size-2.5" />
                        </span>
                        <span className="min-w-0 truncate font-medium text-foreground/90">
                          {username}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "min-w-[56px] shrink-0 text-right font-semibold tabular-nums",
                          up && "text-rose-600 dark:text-rose-400",
                          down && "text-emerald-600 dark:text-emerald-400",
                          !up && !down && "text-muted-foreground",
                        )}
                      >
                        {sign}
                        {formatCurrency(Math.abs(h.netHoldingsChange))}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
