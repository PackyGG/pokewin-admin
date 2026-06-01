"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Info, Loader2, Trophy, Users } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type {
  LifetimePrizesByRaceType,
  LifetimePrizesTopWinner,
  PrizeBudgetTierRow,
} from "@/lib/queries/rewards-analytics-leaderboards";
import { fetchLifetimePrizesTopWinners } from "./drilldown-actions";

/**
 * Drilldown popover for the leaderboard KPI tiles
 * ("Lifetime prizes paid" + "Per-race prize budget") on
 * /rewards/analytics. Different data shape from the per-category
 * reward popovers (race_claims / race_prize_tiers vs.
 * ledger_transactions) so it lives in its own component, but the
 * popover chrome + lazy-expander pattern + rose colour are
 * intentionally identical to RewardTileDrilldown so the page reads
 * as one consistent surface.
 *
 * House-POV: prize payouts and prize budgets are money flowing OUT
 * to users → rose everywhere.
 */

export function LifetimePrizesPopover({
  byRaceType,
  total,
  claims,
}: {
  byRaceType: LifetimePrizesByRaceType[];
  total: number;
  claims: number;
}) {
  const rows = byRaceType.filter((r) => r.total > 0);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Show lifetime prizes breakdown"
            title="Show lifetime prizes breakdown"
            className="rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[340px] max-w-[calc(100vw-2rem)] space-y-2.5 p-3"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Lifetime prizes paid
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            All-time · {formatNumber(claims)} prize claims across every
            race type.
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>
              By race type
              {rows.length > 0 && (
                <span className="ml-1 text-muted-foreground/60">
                  · {rows.length}
                </span>
              )}
            </span>
            <span className="font-semibold tabular-nums text-rose-500 dark:text-rose-400">
              {formatCurrency(total)}
            </span>
          </div>
          {rows.length === 0 ? (
            <p className="px-1 text-[10px] text-muted-foreground/60">
              No prize claims have been filed.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {rows.map((r) => (
                <li
                  key={r.raceType}
                  className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate capitalize">{r.raceType}</span>
                    <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                      · {formatNumber(r.claims)}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-rose-500/90 dark:text-rose-400/90">
                    {formatCurrency(r.total)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <LazyTopWinners />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Lazy expander loading the all-time top prize winners across every
 * race type. Same UX pattern as the reward popovers — first click
 * fetches + caches, subsequent toggles reuse the cached rows.
 */
function LazyTopWinners() {
  const [state, setState] = useState<{
    open: boolean;
    rows: LifetimePrizesTopWinner[] | null;
    error: string | null;
  }>({ open: false, rows: null, error: null });
  const [isPending, startTransition] = useTransition();

  const handleToggle = () => {
    if (state.open) {
      setState((s) => ({ ...s, open: false }));
      return;
    }
    if (state.rows) {
      setState((s) => ({ ...s, open: true }));
      return;
    }
    startTransition(async () => {
      try {
        const rows = await fetchLifetimePrizesTopWinners(10);
        setState({ open: true, rows, error: null });
      } catch (err) {
        setState({
          open: true,
          rows: null,
          error: err instanceof Error ? err.message : "Failed to load winners",
        });
      }
    });
  };

  return (
    <div className="border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={handleToggle}
        disabled={isPending}
        className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
      >
        <span className="inline-flex items-center gap-1.5">
          <Users className="size-3" />
          {state.open ? "Hide" : "Show"} top 10 winners (all time)
        </span>
        {isPending ? (
          <Loader2 className="size-3 animate-spin" />
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
        <div className="mt-1.5">
          {state.error ? (
            <p className="px-1.5 py-2 text-[10px] text-rose-400">
              {state.error}
            </p>
          ) : state.rows && state.rows.length > 0 ? (
            <ul className="space-y-0.5">
              {state.rows.map((r, idx) => {
                const display = r.username ?? `${r.userId.slice(0, 6)}…`;
                return (
                  <li key={r.userId}>
                    <Link
                      href={`/users/${r.userId}`}
                      className="flex items-center justify-between gap-2 rounded px-1 py-1 text-[11px] transition-colors hover:bg-muted/60"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                          {idx + 1}.
                        </span>
                        <span className="truncate font-medium">{display}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 tabular-nums">
                        <span className="text-muted-foreground/60">
                          {formatNumber(r.claims)}{" "}
                          {r.claims === 1 ? "claim" : "claims"}
                        </span>
                        <span className="min-w-[64px] text-right font-semibold text-rose-500 dark:text-rose-400">
                          {formatCurrency(r.total)}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-1.5 py-2 text-[10px] text-muted-foreground">
              No prize winners yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Per-tier prize budget breakdown popover for the "Per-race prize
 * budget" KPI. Static — no lazy expander, the tier list IS the
 * answer. Grouped by race type with each tier's position + dollar
 * amount; total at the top reconciles to the tile headline.
 */
export function PrizeBudgetPopover({
  rows,
  total,
}: {
  rows: PrizeBudgetTierRow[];
  total: number;
}) {
  // Group rows by race type for display so the popover reads as
  // "daily: position 1 $X, position 2 $Y, …; weekly: …".
  const grouped = new Map<string, PrizeBudgetTierRow[]>();
  for (const r of rows) {
    const arr = grouped.get(r.raceType);
    if (arr) {
      arr.push(r);
    } else {
      grouped.set(r.raceType, [r]);
    }
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Show prize budget breakdown"
            title="Show prize budget breakdown"
            className="rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[340px] max-w-[calc(100vw-2rem)] space-y-2.5 p-3"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Per-race prize budget
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            Static budget — what every race period costs the house.
            Sourced from <code className="font-mono">race_prize_tiers</code>.
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>By race × position</span>
            <span className="font-semibold tabular-nums text-rose-500 dark:text-rose-400">
              {formatCurrency(total)}
            </span>
          </div>
          {grouped.size === 0 ? (
            <p className="px-1 text-[10px] text-muted-foreground/60">
              No prize tiers configured.
            </p>
          ) : (
            Array.from(grouped.entries()).map(([raceType, tiers]) => {
              const raceTotal = tiers.reduce(
                (a, t) => a + t.prizeAmountUsd,
                0,
              );
              return (
                <div key={raceType} className="space-y-0.5">
                  <div className="flex items-center justify-between border-t border-border/40 px-1 pt-1 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                    <span className="inline-flex items-center gap-1">
                      <Trophy className="size-3" />
                      <span className="capitalize">{raceType}</span>
                    </span>
                    <span className="tabular-nums">
                      {formatCurrency(raceTotal)}
                    </span>
                  </div>
                  <ul className="space-y-0.5">
                    {tiers.map((t) => (
                      <li
                        key={`${t.raceType}-${t.position}`}
                        className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40"
                      >
                        <span className="truncate text-muted-foreground">
                          #{t.position}
                        </span>
                        <span className="shrink-0 tabular-nums text-rose-500/90 dark:text-rose-400/90">
                          {formatCurrency(t.prizeAmountUsd)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
