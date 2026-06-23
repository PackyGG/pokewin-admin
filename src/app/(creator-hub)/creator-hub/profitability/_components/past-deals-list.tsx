"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/utils/format";

import type { PastDealRow } from "../_queries/past-deals";

/**
 * Per-board past-deal list. Same row anatomy as the Active view's
 * `ProfitabilityList`, just keyed by board (one row per past leaderboard
 * = one row per past deal). House-POV colours: deal cost = rose; actual
 * wager = emerald; conversion ≥ 1× = emerald.
 *
 * CLIENT COMPONENT. Two reasons it must be `"use client"`:
 *   1. `buttonVariants()` is exported from a `"use client"` module
 *      (`src/components/ui/button.tsx`). Calling it from a server-rendered
 *      tree throws the boundary error:
 *        "Attempted to call buttonVariants() from the server but
 *         buttonVariants is on the client."
 *      That throw was the prod incident on `?tab=past` (Vercel error
 *      digest `1881631599`, surfaced as the page-level 500 the owner saw
 *      as digest `3304963582` after the route error boundary caught it).
 *   2. `endedAgoLabel` reads `Date.now()` at render time. As a server
 *      component the server snapshot disagrees with the client's clock on
 *      hydration → a flash + a console "hydration mismatch". As a client
 *      component both renders use the same clock.
 *
 * Mirrors the Active view's `ProfitabilityList`, which is also `"use client"`
 * for the same shape. Props (`PastDealRow`) are plain serializable JSON.
 *
 * Pagination is SERVER-SIDE via `?page=`: the page link below switches the
 * URL param, the parent `<Suspense key={`past-${page}`}>` flips into the
 * skeleton, and the server re-renders just the next page's 25 rows
 * (Active-Timeframe-Only: no eager pre-load of every page).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function conversionClass(rate: number): string {
  if (rate >= 1) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 0.5) return "text-amber-600 dark:text-amber-400";
  if (rate > 0) return "text-rose-600 dark:text-rose-400";
  return "text-muted-foreground";
}

/**
 * House-POV color for Actual PnL = affiliates made us − deal cost.
 * Positive = house gain → emerald; negative = house loss → rose.
 */
function housePnlClass(value: number): string {
  if (value > 0) return "text-emerald-600 dark:text-emerald-400";
  if (value < 0) return "text-rose-600 dark:text-rose-400";
  return "text-muted-foreground";
}

function frameLabel(row: PastDealRow): string {
  const range = `${DATE_FMT.format(row.frameStartMs)} – ${DATE_FMT.format(
    row.frameEndMs,
  )}`;
  const days = Math.max(
    1,
    Math.round((row.frameEndMs - row.frameStartMs) / MS_PER_DAY),
  );
  return `${range} · ${days} day${days === 1 ? "" : "s"} · ended`;
}

function endedAgoLabel(row: PastDealRow): string {
  const days = Math.floor((Date.now() - row.frameEndMs) / MS_PER_DAY);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="sm:w-28 sm:text-right">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("text-sm font-semibold tabular-nums", className)}>
        {value}
      </div>
    </div>
  );
}

function PastDealItem({ row }: { row: PastDealRow }) {
  const initial = (row.username ?? row.boardTitle ?? "?").slice(0, 1).toUpperCase();
  const breakdown = `Prize ${formatCurrency(row.prizeUsd)} · House ${row.sponsoredPct.toFixed(
    0,
  )}% = ${formatCurrency(row.dealCost)}`;

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="size-10 shrink-0">
          <AvatarImage src={row.image ?? undefined} alt={row.username ?? ""} />
          <AvatarFallback>{initial}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href={`/creator-hub/creators/${row.userId}`}
              className="truncate text-sm font-semibold hover:underline"
            >
              {row.username ?? "Unknown creator"}
            </Link>
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              Ended
            </span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {row.boardTitle} · {frameLabel(row)}
          </div>
          <div className="truncate text-[10px] text-muted-foreground/70">
            {breakdown} · {endedAgoLabel(row)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:items-center sm:gap-6">
        <div className="col-span-2 flex items-center gap-3 rounded-lg border bg-background/40 px-3 py-1.5 sm:col-span-1">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Affiliates Made Us
            </div>
            <div
              className={cn(
                "text-sm font-semibold tabular-nums",
                housePnlClass(row.affiliatesMadeUs),
              )}
            >
              {row.affiliatesMadeUs >= 0 ? "+" : ""}
              {formatCurrency(row.affiliatesMadeUs)}
            </div>
          </div>
          <div className="h-7 w-px bg-border" />
          <div
            title={`Affiliates made us ${formatCurrency(
              row.affiliatesMadeUs,
            )} (cohort deposits − card withdrawals − the creator's own affiliate_claim earnings, this board's window) − deal cost ${formatCurrency(
              row.dealCost,
            )}. Positive = the affiliates earned back more than the deal cost.`}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Actual PnL
            </div>
            <div
              className={cn(
                "text-sm font-semibold tabular-nums",
                housePnlClass(row.actualPnl),
              )}
            >
              {row.actualPnl >= 0 ? "+" : ""}
              {formatCurrency(row.actualPnl)}
            </div>
          </div>
        </div>
        <Metric
          label="Deal Cost"
          value={formatCurrency(row.dealCost)}
          className="text-rose-600 dark:text-rose-400"
        />
        <Metric label="Expected Wager" value={formatCurrency(row.expectedWager)} />
        <Metric
          label="Actual Wager"
          value={formatCurrency(row.actualWager)}
          className="text-emerald-600 dark:text-emerald-400"
        />
        <Metric
          label="Conversion"
          value={`${row.conversionRate.toFixed(2)}x`}
          className={conversionClass(row.conversionRate)}
        />
      </div>
    </div>
  );
}

function pageHref(page: number): string {
  // Stays on the same route; ?tab=past is preserved by the parent shell
  // (the tab strip writes / clears it). We only flip ?page=.
  const params = new URLSearchParams();
  params.set("tab", "past");
  if (page > 1) params.set("page", String(page));
  return `?${params.toString()}`;
}

export function PastDealsList({
  rows,
  page,
  totalPages,
  totalCount,
  backendUnavailable,
}: {
  rows: PastDealRow[];
  page: number;
  totalPages: number;
  totalCount: number;
  backendUnavailable: boolean;
}) {
  if (backendUnavailable) {
    return (
      <div className="rounded-2xl border bg-card p-10 text-center text-sm text-muted-foreground">
        Couldn&apos;t load past deals from the backend. Try refreshing in a
        moment.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-10 text-center text-sm text-muted-foreground">
        No past deals yet — every approved leaderboard is still live or
        scheduled.
      </div>
    );
  }

  const first = (page - 1) * 25 + 1;
  const last = Math.min(page * 25, totalCount);
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

  return (
    <div className="space-y-3">
      <div className="divide-y overflow-hidden rounded-2xl border bg-card">
        {rows.map((row) => (
          <PastDealItem key={row.boardId} row={row} />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {first}–{last} of {totalCount} past deals
          </span>
          <div className="flex items-center gap-2">
            {prevDisabled ? (
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" />
              </Button>
            ) : (
              <Link
                href={pageHref(page - 1)}
                scroll={false}
                aria-label="Previous page"
                className={cn(
                  buttonVariants({ variant: "outline", size: "icon" }),
                  "size-8",
                )}
              >
                <ChevronLeft className="size-4" />
              </Link>
            )}
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            {nextDisabled ? (
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled
                aria-label="Next page"
              >
                <ChevronRight className="size-4" />
              </Button>
            ) : (
              <Link
                href={pageHref(page + 1)}
                scroll={false}
                aria-label="Next page"
                className={cn(
                  buttonVariants({ variant: "outline", size: "icon" }),
                  "size-8",
                )}
              >
                <ChevronRight className="size-4" />
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
