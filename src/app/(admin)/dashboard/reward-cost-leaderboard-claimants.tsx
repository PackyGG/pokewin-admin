"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Loader2, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { fetchLeaderboardOnSiteClaimants } from "./reward-cost-leaderboard-actions";
import type {
  LeaderboardOnSiteBoard,
  LeaderboardOnSiteBreakdown,
} from "@/lib/queries/dashboard-reward-costs-today";

/**
 * Inline expandable drilldown under the Reward Costs popover's "Leaderboard
 * prizes (on-site)" line. Clicking it loads — lazily, on first open — the
 * per-claimant breakdown of the on-site slice, grouped by leaderboard, and
 * toggles open. Mirrors the proven GGR "Show top contributors" expander
 * (`revenue-stat-card.tsx`): a `useTransition` + `useState` fetch that fires
 * the server action the FIRST time it opens, caches the result in local
 * state, and reuses it on re-toggle (no re-fetch). The dashboard's initial
 * render never calls the action — the data loads strictly on the click that
 * expands this (CLAUDE.md active-timeframe / lazy rule).
 *
 * Every on-site amount is money the house paid out to a user → a house cost
 * → rose per CLAUDE.md's House-POV rule. The per-claimant on-site figures
 * reconcile to the line above (`onSiteTotal`) by construction: each row is
 * carved by its board's sponsored % exactly as the line total is, so the
 * board totals and the grand total sum back to the figure on the card.
 */
export function LeaderboardOnSiteClaimants({
  onSiteTotal,
}: {
  /** The card's "Leaderboard prizes (on-site)" amount — what this reconciles to. */
  onSiteTotal: number;
}) {
  const [state, setState] = useState<{
    open: boolean;
    data: LeaderboardOnSiteBreakdown | null;
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
        const data = await fetchLeaderboardOnSiteClaimants();
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
        title={`On-site leaderboard slice today: ${formatCurrency(onSiteTotal)}`}
        className="flex w-full items-center justify-between rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
      >
        <span>{state.open ? "Hide" : "Show"} who won (on-site slice)</span>
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
              {/* Reconciliation footer: the per-claimant on-site amounts sum
                  to the line on the card above. */}
              <div className="flex items-center justify-between border-t border-border/60 px-1.5 pt-1.5 text-[10px]">
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                  Total on-site
                </span>
                <span className="font-bold tabular-nums text-rose-600 dark:text-rose-400">
                  −{formatCurrency(state.data.totalOnSite)}
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
 * One leaderboard's group: a header (title + sponsored % + the board's
 * on-site slice) and the per-claimant rows beneath it. The header shows the
 * sponsored % so the on-site/creator split is legible — a 100%-sponsored
 * board contributes $0 here (its whole prize is the creator's our-cut share
 * in the Creators Costs box) and reads as such.
 */
function BoardGroup({ board }: { board: LeaderboardOnSiteBoard }) {
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
              {board.sponsoredPct}% sponsored · gross{" "}
              {formatCurrency(board.gross)} · our cut{" "}
              {formatCurrency(board.ourCut)}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[9px] uppercase tracking-wider text-muted-foreground">
            on-site
          </span>
          <span
            className={cn(
              "block text-[11px] font-semibold tabular-nums",
              board.onSite > 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground",
            )}
          >
            −{formatCurrency(board.onSite)}
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
                <span className="flex shrink-0 items-center gap-2 tabular-nums">
                  {/* Gross prize this claimant won on this board (context). */}
                  <span className="text-muted-foreground/70">
                    won {formatCurrency(c.gross)}
                  </span>
                  {/* The on-site slice attributed to this claimant — rose
                      (house cost). Sums to the board + grand totals. */}
                  <span
                    className={cn(
                      "min-w-[56px] text-right font-semibold",
                      c.onSite > 0
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-muted-foreground",
                    )}
                  >
                    −{formatCurrency(c.onSite)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
