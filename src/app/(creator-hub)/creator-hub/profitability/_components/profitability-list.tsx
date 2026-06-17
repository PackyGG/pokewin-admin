import Link from "next/link";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency } from "@/lib/utils/format";
import type { CreatorProfitabilityRow } from "../_queries/deal-profitability";

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
  const breakdown = `Cap ${formatCurrency(row.capUsd)} · LB ${formatCurrency(
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
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-10 text-center text-sm text-muted-foreground">
        No creators with a current deal to cost out yet.
      </div>
    );
  }

  return (
    <div className="divide-y overflow-hidden rounded-2xl border bg-card">
      {rows.map((row) => (
        <ProfitabilityRow key={row.userId} row={row} />
      ))}
    </div>
  );
}
