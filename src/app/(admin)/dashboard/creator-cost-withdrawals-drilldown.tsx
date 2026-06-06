"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowUpFromLine, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { fetchCreatorWithdrawalsBreakdown } from "./creator-cost-withdrawals-actions";
import type {
  CreatorWithdrawalCreator,
  CreatorWithdrawalsBreakdown,
} from "@/lib/queries/dashboard-creator-costs-today";

/**
 * Inline expandable drilldown under the Creators Costs popover's "Creator
 * withdrawals" line. Clicking it loads — lazily, on first open — the
 * per-creator / per-request breakdown of today's deal-payout cash-outs and
 * toggles open. Mirrors `LeaderboardGrossClaimants`: a `useTransition` +
 * `useState` fetch that fires the server action the FIRST time it opens,
 * caches the result in local state, and reuses it on re-toggle (no
 * re-fetch). The dashboard's initial render never calls the action.
 *
 * Every amount is deal-payout voucher value the house paid out when a
 * creator cashed out → a house cost → rose per House-POV. Per-creator and
 * grand totals reconcile to the line above (`withdrawalsTotal`) by
 * construction (same `creator_deal_payouts` CTE as the aggregate).
 */
export function CreatorWithdrawalsDrilldown({
  withdrawalsTotal,
}: {
  /** The card's "Creator withdrawals" amount — what this reconciles to. */
  withdrawalsTotal: number;
}) {
  const [state, setState] = useState<{
    open: boolean;
    data: CreatorWithdrawalsBreakdown | null;
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
        const data = await fetchCreatorWithdrawalsBreakdown();
        setState({ open: true, data, error: null });
      } catch (err) {
        setState({
          open: true,
          data: null,
          error:
            err instanceof Error ? err.message : "Failed to load withdrawals",
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
        title={`Creator withdrawals today: ${formatCurrency(withdrawalsTotal)}`}
        className="flex w-full items-center justify-between rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
      >
        <span>{state.open ? "Hide" : "Show"} who withdrew</span>
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
          ) : state.data.creators.length === 0 ? (
            <p className="px-1.5 py-2 text-[10px] text-muted-foreground">
              No creator deal-payout withdrawals today.
            </p>
          ) : (
            <div className="space-y-1.5">
              {state.data.creators.map((creator) => (
                <CreatorGroup key={creator.creatorUserId} creator={creator} />
              ))}
              <div className="flex items-center justify-between border-t border-border/60 px-1.5 pt-1.5 text-[10px]">
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                  Total withdrawals
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

/**
 * One creator's group: header (username + today's deal-payout total) and
 * per-request rows beneath it.
 */
function CreatorGroup({ creator }: { creator: CreatorWithdrawalCreator }) {
  const displayName =
    creator.username ?? `${creator.creatorUserId.slice(0, 6)}…`;
  const href = `/creator-hub/creators/${creator.creatorUserId}`;
  const requestLabel =
    creator.withdrawals.length === 1 ? "request" : "requests";

  return (
    <div className="rounded border border-border/50">
      <div className="flex items-center justify-between gap-2 border-b border-border/40 px-1.5 py-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
            <ArrowUpFromLine className="size-2.5" />
          </span>
          <span className="min-w-0">
            <Link
              href={href}
              className="block truncate text-[10px] font-medium text-foreground/90 hover:underline"
            >
              {displayName}
            </Link>
            <span className="block truncate text-[9px] text-muted-foreground">
              {creator.withdrawals.length} {requestLabel}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[9px] uppercase tracking-wider text-muted-foreground">
            cashed out
          </span>
          <span
            className={cn(
              "block text-[11px] font-semibold tabular-nums",
              creator.amount > 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground",
            )}
          >
            −{formatCurrency(creator.amount)}
          </span>
        </span>
      </div>
      <ul className="divide-y divide-border/40">
        {creator.withdrawals.map((w) => (
          <li key={w.requestId}>
            <div className="flex items-center justify-between gap-2 px-1.5 py-1 text-[10px]">
              <span className="min-w-0">
                <Link
                  href={`/users/${creator.creatorUserId}`}
                  className="block truncate font-medium text-foreground/90 hover:underline"
                >
                  {formatWithdrawalLabel(w.origins, w.voucherCount)}
                </Link>
                <span className="block truncate text-[9px] text-muted-foreground tabular-nums">
                  {formatEffectiveAt(w.effectiveAtIso)}
                </span>
              </span>
              <span
                className={cn(
                  "min-w-[56px] shrink-0 text-right font-semibold tabular-nums",
                  w.amount > 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
                )}
              >
                −{formatCurrency(w.amount)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatWithdrawalLabel(
  origins: Array<"creator_fill_conversion" | "creator_multiplier_payout">,
  voucherCount: number,
): string {
  const voucherLabel = voucherCount === 1 ? "voucher" : "vouchers";
  if (origins.length === 0) {
    return `${voucherCount} deal-payout ${voucherLabel}`;
  }
  if (origins.length === 1) {
    const originLabel =
      origins[0] === "creator_fill_conversion"
        ? "fill payout"
        : "multiplier payout";
    return `${voucherCount} ${originLabel} ${voucherLabel}`;
  }
  return `${voucherCount} deal-payout ${voucherLabel}`;
}

function formatEffectiveAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  });
}
