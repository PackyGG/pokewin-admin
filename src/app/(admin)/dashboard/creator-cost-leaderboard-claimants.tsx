"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Loader2, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { fetchLeaderboardGrossClaimants } from "./creator-cost-leaderboard-actions";
import type {
  LeaderboardGrossBoard,
  LeaderboardGrossBreakdown,
} from "@/lib/queries/dashboard-creator-costs-today";

/**
 * Inline expandable drilldown under the Creators Costs popover's "Leaderboard
 * prizes" line. Clicking it loads — lazily, on first open — the per-claimant
 * breakdown of today's leaderboard prizes, grouped by leaderboard, and toggles
 * open. Mirrors the proven GGR "Show top contributors" expander
 * (`revenue-stat-card.tsx`): a `useTransition` + `useState` fetch that fires
 * the server action the FIRST time it opens, caches the result in local state,
 * and reuses it on re-toggle (no re-fetch). The dashboard's initial render
 * never calls the action — the data loads strictly on the click that expands
 * this (CLAUDE.md active-timeframe / lazy rule).
 *
 * Every leaderboard prize is a creator-run-event cost counted in FULL on this
 * box (owner, 2026-06-04), so each amount shown is the user's full gross win =
 * money the house paid out → a house cost → rose per CLAUDE.md's House-POV
 * rule. The per-claimant gross figures reconcile to the line above
 * (`grossTotal`) by construction: there is no carve-out, so the board totals
 * and the grand total sum straight back to the figure on the card.
 */
export function LeaderboardGrossClaimants({
  grossTotal,
}: {
  /** The card's "Leaderboard prizes" amount — what this reconciles to. */
  grossTotal: number;
}) {
  const [state, setState] = useState<{
    open: boolean;
    data: LeaderboardGrossBreakdown | null;
    error: string | null;
  }>({ open: false, data: null, error: null });
  const [isPending, startTransition] = useTransition();

  const handleToggle = () => {
    if (state.open) {
      setState((s) => ({ ...s, open: false }));
      return;
    }
    // First open: fire the action. Subsequent opens reuse the cached data in
    // state (no re-fetch on close→open within the same instance).
    if (state.data) {
      setState((s) => ({ ...s, open: true }));
      return;
    }
    startTransition(async () => {
      try {
        const data = await fetchLeaderboardGrossClaimants();
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
        title={`Leaderboard prizes today: ${formatCurrency(grossTotal)}`}
        className="flex w-full items-center justify-between rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
      >
        <span>{state.open ? "Hide" : "Show"} who won</span>
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
          ) : state.data.boards.length === 0 ? (
            <p className="px-1.5 py-2 text-[10px] text-muted-foreground">
              No leaderboard prizes paid out today.
            </p>
          ) : (
            <div className="space-y-1.5">
              {state.data.boards.map((board) => (
                <BoardGroup
                  key={board.leaderboardId ?? "none"}
                  board={board}
                />
              ))}
              {/* Reconciliation footer: the per-claimant gross amounts sum to
                  the line on the card above. */}
              <div className="flex items-center justify-between border-t border-border/60 px-1.5 pt-1.5 text-[10px]">
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                  Total leaderboard
                </span>
                <span className="font-bold tabular-nums text-rose-600 dark:text-rose-400">
                  −{formatCurrency(state.data.totalGross)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One leaderboard's group: a header (title + the board's gross pool) and the
 * per-claimant rows beneath it. Every prize on this box is counted in full,
 * so the board gross is simply the sum of its claimants' wins — no sponsored-%
 * or our-cut split (that lives on the separate /creators surface).
 */
function BoardGroup({ board }: { board: LeaderboardGrossBoard }) {
  const title = board.title ?? "Leaderboard win";
  const href = board.leaderboardId
    ? `/creators/leaderboards/${board.leaderboardId}`
    : null;
  return (
    <div className="rounded border border-border/50">
      <div className="flex items-center justify-between gap-2 border-b border-border/40 px-1.5 py-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
            <Trophy className="size-2.5" />
          </span>
          <span className="min-w-0">
            {href ? (
              <Link
                href={href}
                className="block truncate text-[10px] font-medium text-foreground/90 hover:underline"
              >
                {title}
              </Link>
            ) : (
              <span className="block truncate text-[10px] font-medium text-foreground/90">
                {title}
              </span>
            )}
            <span className="block truncate text-[9px] text-muted-foreground">
              {board.claimants.length}{" "}
              {board.claimants.length === 1 ? "winner" : "winners"}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[9px] uppercase tracking-wider text-muted-foreground">
            gross
          </span>
          <span
            className={cn(
              "block text-[11px] font-semibold tabular-nums",
              board.gross > 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground",
            )}
          >
            −{formatCurrency(board.gross)}
          </span>
        </span>
      </div>
      <ul className="divide-y divide-border/40">
        {board.claimants.map((c) => {
          const username = c.username ?? `${c.userId.slice(0, 6)}…`;
          return (
            <li key={c.userId}>
              <Link
                href={`/users/${c.userId}`}
                className="flex items-center justify-between gap-2 px-1.5 py-1 text-[10px] transition-colors hover:bg-muted/50"
              >
                <span className="min-w-0 truncate font-medium text-foreground/90">
                  {username}
                </span>
                {/* The gross prize this claimant won — rose (house cost).
                    Sums to the board + grand totals. */}
                <span
                  className={cn(
                    "min-w-[56px] shrink-0 text-right font-semibold tabular-nums",
                    c.gross > 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                  )}
                >
                  −{formatCurrency(c.gross)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
