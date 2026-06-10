"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Loader2, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { fetchRaceWinClaimants } from "./reward-cost-race-actions";
import type { RaceWinClaimantsBreakdown } from "@/lib/queries/dashboard-reward-costs-today";

/**
 * Inline expandable drilldown under the Reward Costs popover's "Race wins"
 * line. Lazy-loads who claimed platform race prizes today.
 */
export function RaceWinClaimants({
  raceTotal,
}: {
  /** The card's "Race wins" amount — what this reconciles to. */
  raceTotal: number;
}) {
  const [state, setState] = useState<{
    open: boolean;
    data: RaceWinClaimantsBreakdown | null;
    error: string | null;
  }>({ open: false, data: null, error: null });
  const [isPending, startTransition] = useTransition();

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
        const data = await fetchRaceWinClaimants();
        setState({ open: true, data, error: null });
      } catch (err) {
        setState({
          open: true,
          data: null,
          error:
            err instanceof Error ? err.message : "Failed to load claimants",
        });
      }
    });
  };

  return (
    <div className="mt-1 pl-[26px]">
      <button
        type="button"
        onClick={handleToggle}
        disabled={isPending}
        aria-expanded={state.open}
        title={`Race wins today: ${formatCurrency(raceTotal)}`}
        className="flex w-full items-center justify-between rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
      >
        <span>{state.open ? "Hide" : "Show"} who claimed</span>
        {isPending ? (
          <Loader2 className="size-3 motion-safe:animate-spin" />
        ) : (
          <ChevronDown
            className={cn(
              "size-3 transition-transform",
              state.open && "rotate-180",
            )}
          />
        )}
      </button>

      {state.open && (
        <div className="mt-1">
          {state.error ? (
            <p className="px-1.5 py-2 text-[10px] text-rose-400">
              {state.error}
            </p>
          ) : !state.data ? (
            <p className="px-1.5 py-2 text-[10px] text-muted-foreground">
              Loading…
            </p>
          ) : state.data.claims.length === 0 ? (
            <p className="px-1.5 py-2 text-[10px] text-muted-foreground">
              No race prizes paid out today.
            </p>
          ) : (
            <div className="space-y-1">
              <ul className="divide-y divide-border/40 rounded border border-border/50">
                {state.data.claims.map((c) => {
                  const username = c.username ?? `${c.userId.slice(0, 6)}…`;
                  return (
                    <li key={`${c.userId}-${c.claimedAtIso}`}>
                      <Link
                        href={`/users/${c.userId}`}
                        className="flex items-center justify-between gap-2 px-1.5 py-1 text-[10px] transition-colors hover:bg-muted/50"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                            <Trophy className="size-2.5" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-foreground/90">
                              {username}
                            </span>
                            <span className="block truncate text-[9px] text-muted-foreground">
                              {c.raceType
                                ? `${c.raceType} race · `
                                : ""}
                              {formatRelative(c.claimedAtIso)}
                            </span>
                          </span>
                        </span>
                        <span
                          className={cn(
                            "min-w-[56px] shrink-0 text-right font-semibold tabular-nums",
                            c.amount > 0
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-muted-foreground",
                          )}
                        >
                          −{formatCurrency(c.amount)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center justify-between border-t border-border/60 px-1.5 pt-1.5 text-[10px]">
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                  Total race wins
                </span>
                <span className="font-bold tabular-nums text-rose-600 dark:text-rose-400">
                  −{formatCurrency(state.data.totalAmount)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
