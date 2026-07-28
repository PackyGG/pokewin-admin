"use client";

import { History } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CreatorDealResponse } from "@/lib/backend-api";

import { DEAL_STATUS_COLORS } from "./status-badges";

function num(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Creator Hub — "Previous deals" preview modal.
 *
 * Read-only list of the creator's PAST deals (completed / terminated — ended
 * by any means), so a manager can review prior terms without leaving the
 * creator page. Receives only serializable deal records. Controlled by the
 * deal actions overflow menu (no own trigger).
 */
export function PreviousDealsDialog({
  deals,
  open,
  onOpenChange,
}: {
  deals: CreatorDealResponse[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sorted = [...deals].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-zinc-500/15 text-zinc-600 ring-1 ring-inset ring-zinc-500/30 dark:text-zinc-400">
              <History className="size-4" />
            </span>
            Previous deals
          </DialogTitle>
          <DialogDescription>
            Past deals for this creator that ended (completed or terminated).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {sorted.map((deal) => {
            const withdrawCap = deal.total_withdraw_cap_usd;
            return (
              <div key={deal.id} className="rounded-lg border bg-background/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] capitalize",
                        DEAL_STATUS_COLORS[deal.status],
                      )}
                    >
                      {deal.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(deal.week_start_utc)} →{" "}
                      {formatDate(deal.week_end_utc)}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    v{deal.version} · created {formatDate(deal.created_at)}
                  </span>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Term label="Fills" value={`${deal.fills_used} / ${deal.fills_allowed}`} />
                  <Term
                    label="Per fill"
                    value={formatCurrency(num(deal.per_fill_amount_usd))}
                  />
                  <Term
                    label="Conversion"
                    value={`${(deal.conversion_rate_bps / 100).toFixed(2)}%`}
                  />
                  <Term
                    label="Withdraw cap"
                    value={
                      withdrawCap == null
                        ? "—"
                        : `${formatCurrency(num(deal.withdraw_cap_used_usd))} / ${formatCurrency(num(withdrawCap))}`
                    }
                    valueClassName={
                      withdrawCap != null
                        ? "text-rose-600 dark:text-rose-400"
                        : undefined
                    }
                  />
                  <Term
                    label="Tip / stream"
                    value={formatCurrency(num(deal.max_tip_per_stream_usd))}
                  />
                  <Term
                    label="Sponsor / stream"
                    value={formatCurrency(num(deal.max_sponsorship_per_stream_usd))}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Term({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-sm font-semibold tabular-nums", valueClassName)}>
        {value}
      </div>
    </div>
  );
}
