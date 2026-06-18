"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Loader2, Coins } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { fetchPromoBalanceCreditClaimants } from "./reward-cost-promo-actions";
import type { PromoBalanceCreditClaimantsBreakdown } from "@/lib/queries/dashboard-reward-costs-today";

/**
 * Inline expandable drilldown under the Reward Costs popover's "Promo
 * balance credits" line. Lazy-loads WHO received counted balance-adjustment
 * credits today + the category of each (giveaway / bonus / reload / …).
 */
export function PromoBalanceCreditClaimants({
  creditTotal,
}: {
  /** The card's "Promo balance credits" amount — what this reconciles to. */
  creditTotal: number;
}) {
  const [state, setState] = useState<{
    open: boolean;
    data: PromoBalanceCreditClaimantsBreakdown | null;
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
        const data = await fetchPromoBalanceCreditClaimants();
        setState({ open: true, data, error: null });
      } catch (err) {
        setState({
          open: true,
          data: null,
          error:
            err instanceof Error ? err.message : "Failed to load recipients",
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
        title={`Promo balance credits today: ${formatCurrency(creditTotal)}`}
        className="flex w-full items-center justify-between rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
      >
        <span>{state.open ? "Hide" : "Show"} who got credited</span>
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
              No promo balance credits booked today.
            </p>
          ) : (
            <div className="space-y-1">
              <ul className="divide-y divide-border/40 rounded border border-border/50">
                {state.data.claims.map((c, i) => {
                  const username = c.username ?? `${c.userId.slice(0, 6)}…`;
                  return (
                    <li key={`${c.userId}-${c.creditedAtIso}-${i}`}>
                      <Link
                        href={`/users/${c.userId}`}
                        className="flex items-center justify-between gap-2 px-1.5 py-1 text-[10px] transition-colors hover:bg-muted/50"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                            <Coins className="size-2.5" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-foreground/90">
                              {username}
                            </span>
                            <span className="block truncate text-[9px] text-muted-foreground">
                              {c.categoryLabel ? `${c.categoryLabel} · ` : ""}
                              {formatRelative(c.creditedAtIso)}
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
                  Total promo credits
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
