"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowUpFromLine, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { fetchCreatorWithdrawalsBreakdown } from "./creator-cost-withdrawals-actions";
import type {
  CreatorConvertedPayout,
  CreatorWithdrawalCreator,
  CreatorWithdrawalsBreakdown,
} from "@/lib/queries/dashboard-creator-costs-today";

/**
 * Inline expandable drilldown under the Creators Costs popover's "Creator
 * withdrawals" line. Clicking it loads — lazily, on first open — the
 * per-creator / per-voucher breakdown of today's converted deal payouts and
 * toggles open. Mirrors `LeaderboardGrossClaimants`: a `useTransition` +
 * `useState` fetch that fires the server action the FIRST time it opens,
 * caches the result in local state, and reuses it on re-toggle (no
 * re-fetch). The dashboard's initial render never calls the action.
 *
 * Fill rows are stream sessions the creator withdrew from and ended today
 * (`converted_at`); multiplier rows are payout vouchers minted today → house
 * costs → rose per House-POV. Totals reconcile to the line above.
 */
export function CreatorWithdrawalsDrilldown({
  withdrawalsTotal,
}: {
  /** The card's "Converted payouts" amount — what this reconciles to. */
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
        title={`Converted payouts today: ${formatCurrency(withdrawalsTotal)}`}
        className="flex w-full items-center justify-between rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
      >
        <span>{state.open ? "Hide" : "Show"} who withdrew sessions</span>
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
              No converted deal payouts today.
            </p>
          ) : (
            <div className="space-y-1.5">
              {state.data.creators.map((creator) => (
                <CreatorGroup key={creator.creatorUserId} creator={creator} />
              ))}
              <div className="flex items-center justify-between border-t border-border/60 px-1.5 pt-1.5 text-[10px]">
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                  Total converted
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
 * One creator's group: header (username + today's converted total) and
 * per-session / per-voucher rows beneath it.
 */
function CreatorGroup({ creator }: { creator: CreatorWithdrawalCreator }) {
  const displayName =
    creator.username ?? `${creator.creatorUserId.slice(0, 6)}…`;
  const href = `/creator-hub/creators/${creator.creatorUserId}`;
  const payoutLabel = creator.payouts.length === 1 ? "payout" : "payouts";

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
              {creator.payouts.length} {payoutLabel}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[9px] uppercase tracking-wider text-muted-foreground">
            converted
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
        {creator.payouts.map((p) => (
          <li
            key={
              p.kind === "fill_session"
                ? `session-${p.sessionId}`
                : `voucher-${p.voucherId}`
            }
          >
            <div className="flex items-center justify-between gap-2 px-1.5 py-1 text-[10px]">
              <span className="min-w-0">
                <Link
                  href={
                    p.kind === "fill_session"
                      ? `${href}?tab=sessions`
                      : `/users/${creator.creatorUserId}`
                  }
                  className="block truncate font-medium text-foreground/90 hover:underline"
                >
                  {formatPayoutLabel(p)}
                </Link>
                <span className="block truncate text-[9px] text-muted-foreground tabular-nums">
                  {formatPayoutTime(p)}
                </span>
              </span>
              <span
                className={cn(
                  "min-w-[56px] shrink-0 text-right font-semibold tabular-nums",
                  p.amount > 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
                )}
              >
                −{formatCurrency(p.amount)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatPayoutLabel(p: CreatorConvertedPayout): string {
  if (p.kind === "fill_session") {
    return `Session ended · withdrew`;
  }
  return "Multiplier payout";
}

function formatPayoutTime(p: CreatorConvertedPayout): string {
  const iso = p.kind === "fill_session" ? p.convertedAtIso : p.mintedAtIso;
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
