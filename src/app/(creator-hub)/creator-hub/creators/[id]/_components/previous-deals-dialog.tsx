"use client";

import { useState } from "react";
import { History } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CreatorDealResponse } from "@/lib/backend-api";

const STATUS_COLORS: Record<string, string> = {
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  scheduled: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  completed:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  terminated:
    "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

function num(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Creator Hub — "Previous deals" preview modal.
 *
 * Read-only list of the creator's PAST deals (completed / terminated — ended
 * by any means), so a manager can review prior terms without leaving the
 * creator page. Receives only serializable deal records.
 */
export function PreviousDealsDialog({ deals }: { deals: CreatorDealResponse[] }) {
  const [open, setOpen] = useState(false);

  const sorted = [...deals].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <History className="mr-1 size-3.5" />
        Previous deals
        <span className="ml-1 text-muted-foreground">({deals.length})</span>
      </DialogTrigger>

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
                      className={cn("text-[10px] capitalize", STATUS_COLORS[deal.status])}
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
