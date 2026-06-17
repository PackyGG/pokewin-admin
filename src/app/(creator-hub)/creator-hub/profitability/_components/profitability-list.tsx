"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils/format";
import type { CreatorProfitabilityRow } from "../_queries/deal-profitability";

/** Creators per page — rows are already loaded, this is a client-side slice. */
const PAGE_SIZE = 25;

/**
 * Per-creator deal profitability list. Left: avatar + name + code + the
 * current deal frame (board title · dates · "day X/N" or upcoming). Right:
 * deal cost (rose), the wager needed to cover it (expected), the wager
 * actually driven in the frame (emerald), and the conversion ratio.
 *
 * House-POV colours: deal cost is a house cost → rose; actual wager is
 * house throughput income → emerald; conversion ≥ 1× = the creator
 * out-wagered the cost (house win) → emerald.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

function conversionClass(rate: number): string {
  if (rate >= 1) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 0.5) return "text-amber-600 dark:text-amber-400";
  if (rate > 0) return "text-rose-600 dark:text-rose-400";
  return "text-muted-foreground";
}

/** Frame label: dates + day X/N (live), "Upcoming" (not started), or "Ended". */
function frameLabel(row: CreatorProfitabilityRow): string {
  const { frameStartMs, frameEndMs, isLive } = row;
  if (frameStartMs == null || frameEndMs == null) return "No active frame";

  const range = `${DATE_FMT.format(frameStartMs)} – ${DATE_FMT.format(frameEndMs)}`;
  const totalDays = Math.max(
    1,
    Math.round((frameEndMs - frameStartMs) / MS_PER_DAY),
  );
  const now = Date.now();

  if (isLive) {
    const dayN = Math.min(
      totalDays,
      Math.max(1, Math.floor((now - frameStartMs) / MS_PER_DAY) + 1),
    );
    return `${range} · day ${dayN}/${totalDays}`;
  }
  if (frameStartMs > now) return `${range} · upcoming`;
  return `${range} · ended`;
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

function ProfitabilityRow({ row }: { row: CreatorProfitabilityRow }) {
  const initial = (row.username ?? row.code ?? "?").slice(0, 1).toUpperCase();
  const capLabel =
    row.dealWeeks > 1
      ? `Cap ${formatCurrency(row.capUsd)} (${formatCurrency(
          row.weeklyCapUsd,
        )}/wk × ${row.dealWeeks})`
      : `Cap ${formatCurrency(row.capUsd)}`;
  const breakdown = `${capLabel} · LB ${formatCurrency(
    row.leaderboardUsd,
  )} · Tips ${formatCurrency(row.tipSponsorUsd)}`;

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
            {row.code && (
              <span className="shrink-0 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {row.code}
              </span>
            )}
            {row.isLive && (
              <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                Live
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {row.boardTitle ? `${row.boardTitle} · ` : ""}
            {frameLabel(row)}
          </div>
          <div className="truncate text-[10px] text-muted-foreground/70">
            {breakdown}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:items-center sm:gap-6">
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

export function ProfitabilityList({
  rows,
}: {
  rows: CreatorProfitabilityRow[];
}) {
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [rows, safePage],
  );

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-10 text-center text-sm text-muted-foreground">
        No creators with a current deal to cost out yet.
      </div>
    );
  }

  const first = (safePage - 1) * PAGE_SIZE + 1;
  const last = Math.min(safePage * PAGE_SIZE, rows.length);

  return (
    <div className="space-y-3">
      <div className="divide-y overflow-hidden rounded-2xl border bg-card">
        {pageRows.map((row) => (
          <ProfitabilityRow key={row.userId} row={row} />
        ))}
      </div>

      {rows.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {first}–{last} of {rows.length} creators
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {safePage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={safePage >= totalPages}
              onClick={() => setPage(safePage + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
