import Link from "next/link";
import { Gift, Tv, User } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { HubEmptyState, HubNotice } from "../../_components/hub-notice";
import { BackendUnavailableHint } from "../../../../(admin)/creators/_components/backend-unavailable-hint";

import type { CreatorTipsSponsorRow } from "../_queries/tips-sponsors-data";

/**
 * Per-creator tips + sponsor spend ranklist (session-derived totals).
 * Flat panel: `bg-card` + hairline border, `rounded-xl` (panel step of the
 * radius scale), no glow/gradient. Rows keep the Live pill and link through
 * to `/creator-hub/creators/{id}`.
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
      <HubNotice tone="amber" title="Creator session data unavailable">
        <p>
          The packy.gg backend is unreachable, so per-creator tips and sponsor
          totals cannot load. Ledger figures above may still reflect the
          database.
        </p>
        <BackendUnavailableHint text="Backend session API unavailable — per-creator breakdown deferred." />
      </HubNotice>
    );
  }

  if (rows.length === 0) {
    return (
      <HubEmptyState
        icon={Gift}
        title="No tips or sponsors in this window"
        sub="Creators haven't spent from the house-funded tips/sponsor pool during the selected period."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
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
                <Avatar>
                  {row.image && <AvatarImage src={row.image} alt="" />}
                  <AvatarFallback>
                    {row.username ? (
                      row.username.slice(0, 2).toUpperCase()
                    ) : (
                      <User className="size-4" aria-hidden />
                    )}
                  </AvatarFallback>
                </Avatar>
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
