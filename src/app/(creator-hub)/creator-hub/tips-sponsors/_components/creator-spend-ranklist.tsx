import Link from "next/link";
import { Gift, Tv, User } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { BackendUnavailableHint } from "../../../../(admin)/creators/_components/backend-unavailable-hint";

import type { CreatorTipsSponsorRow } from "../_queries/tips-sponsors-data";

/**
 * Per-creator tips + sponsor spend ranklist (session-derived totals).
 */
export function CreatorSpendRanklist({
  rows,
  backendUnavailable,
}: {
  rows: CreatorTipsSponsorRow[];
  backendUnavailable: boolean;
}) {
  if (backendUnavailable) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed bg-card p-6 text-center">
        <p className="text-sm font-semibold">Creator session data unavailable</p>
        <p className="max-w-md text-xs text-muted-foreground">
          The packy.gg backend is unreachable, so per-creator tips and sponsor
          totals cannot load. Ledger figures above may still reflect the database.
        </p>
        <BackendUnavailableHint text="Backend session API unavailable — per-creator breakdown deferred." />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <Gift className="size-4 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold">No tips or sponsors in this window</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Creators haven&apos;t spent from the house-funded tips/sponsor pool
            during the selected period.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="grid grid-cols-[auto_1fr_repeat(4,minmax(0,auto))] gap-x-3 gap-y-0 border-b bg-muted/30 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground max-sm:hidden">
        <span>#</span>
        <span>Creator</span>
        <span className="text-right">Tips</span>
        <span className="text-right">Sponsors</span>
        <span className="text-right">Total</span>
        <span className="text-right">Sessions</span>
      </div>
      <ul className="divide-y">
        {rows.map((row, i) => (
          <li key={row.id}>
            <Link
              href={`/creator-hub/creators/${row.id}`}
              className="grid grid-cols-1 gap-2 px-4 py-3 transition-colors hover:bg-muted/40 sm:grid-cols-[auto_1fr_repeat(4,minmax(0,auto))] sm:items-center sm:gap-x-3"
            >
              <span className="text-xs font-medium text-muted-foreground tabular-nums sm:w-6">
                {i + 1}
              </span>
              <span className="flex min-w-0 items-center gap-2.5">
                {row.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={row.image}
                    alt=""
                    className="size-8 shrink-0 rounded-full object-cover ring-1 ring-border"
                  />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-border">
                    <User className="size-4 text-muted-foreground" />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">
                      {row.username ?? "Unknown"}
                    </span>
                    {row.isLive && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        <Tv className="size-2.5" />
                        Live
                      </span>
                    )}
                  </span>
                </span>
              </span>
              <StatCell label="Tips" value={formatCurrency(row.tipsUsd)} rose />
              <StatCell
                label="Sponsors"
                value={formatCurrency(row.sponsorUsd)}
                rose
              />
              <StatCell
                label="Total"
                value={formatCurrency(row.totalUsd)}
                rose
                bold
              />
              <StatCell
                label="Sessions"
                value={formatNumber(row.sessionsWithSpend)}
              />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatCell({
  label,
  value,
  rose,
  bold,
}: {
  label: string;
  value: string;
  rose?: boolean;
  bold?: boolean;
}) {
  return (
    <span className="flex items-baseline justify-between gap-2 sm:block sm:text-right">
      <span className="text-[11px] text-muted-foreground sm:hidden">{label}</span>
      <span
        className={cn(
          "tabular-nums text-sm",
          bold && "font-semibold",
          rose && "text-rose-600 dark:text-rose-400",
        )}
      >
        {value}
      </span>
    </span>
  );
}
