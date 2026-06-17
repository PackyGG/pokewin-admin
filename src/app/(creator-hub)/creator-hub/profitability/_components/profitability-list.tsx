import Link from "next/link";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency } from "@/lib/utils/format";
import type { CreatorProfitabilityRow } from "../_queries/deal-profitability";

/**
 * Per-creator deal profitability list. Left: avatar + name + code + the
 * deal-cost breakdown (cap · leaderboard · tips). Right: the four headline
 * figures — projected house deal cost (rose), the wager needed to cover it
 * (expected), the wager actually driven in the window (emerald), and the
 * resulting conversion ratio (coloured by how much of the expectation it
 * covers).
 *
 * Colours follow CLAUDE.md house-POV: deal cost is a house cost → rose;
 * actual wager is house throughput income → emerald; conversion ≥ 1×
 * means the creator out-wagered the cost (house win) → emerald.
 */

/** Conversion ≥1× covers the deal (house win → emerald); <0.5× underwater (rose). */
function conversionClass(rate: number): string {
  if (rate >= 1) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 0.5) return "text-amber-600 dark:text-amber-400";
  if (rate > 0) return "text-rose-600 dark:text-rose-400";
  return "text-muted-foreground";
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
  const breakdown = [
    `Cap ${formatCurrency(row.capUsd)}`,
    `LB ${formatCurrency(row.leaderboardUsd)}`,
    `Tips ${formatCurrency(row.tipSponsorUsd)}`,
  ].join(" · ");

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
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
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
        No fill-creator deals to cost out yet.
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
