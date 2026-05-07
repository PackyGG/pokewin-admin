"use client";

import { memo, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Ban, Loader2, PackageOpen } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type {
  CreatorDealResponse,
  CreatorDealStatus,
} from "@/lib/backend-api";

import type { PaginatedSlice } from "../_lib/types";

import { terminateCreatorDeal } from "../../backend-actions";
import { DealFormDialog } from "./deal-form-dialog";

const STATUS_STYLE: Record<CreatorDealStatus, string> = {
  scheduled:
    "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  active:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  completed: "border-muted bg-muted/50 text-muted-foreground",
  terminated:
    "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
};

type Props = {
  userId: string;
  deals: PaginatedSlice<CreatorDealResponse>;
};

export function DealsTab({ userId, deals }: Props) {
  if (deals.total === 0) {
    return (
      <EmptyState
        title="No deals yet"
        description="Create a weekly fill deal to start. Each deal gives the creator a fixed number of fills at a set per-fill amount, with a conversion rate applied when they end a stream."
      />
    );
  }

  return (
    <div>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden divide-y divide-border/60">
        {deals.data.map((deal) => (
          <DealMobileCard key={deal.id} userId={userId} deal={deal} />
        ))}
      </div>

      {/* Desktop wide multi-col table */}
      <div className="hidden overflow-x-auto lg:block">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Week</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Fills</TableHead>
            <TableHead className="text-right">Per Fill</TableHead>
            <TableHead className="text-right">Convert</TableHead>
            <TableHead className="text-right">
              Withdraw cap
              <div className="text-[10px] font-normal normal-case text-muted-foreground/70">
                used / total
              </div>
            </TableHead>
            <TableHead className="text-right">
              Tip max
              <div className="text-[10px] font-normal normal-case text-muted-foreground/70">
                user / stream
              </div>
            </TableHead>
            <TableHead className="text-right">
              Sponsor max
              <div className="text-[10px] font-normal normal-case text-muted-foreground/70">
                battle / stream
              </div>
            </TableHead>
            <TableHead className="pr-4 text-right"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deals.data.map((deal) => (
            <DealRow key={deal.id} userId={userId} deal={deal} />
          ))}
        </TableBody>
      </Table>
      </div>

      {deals.totalPages > 1 && (
        <div className="border-t px-4">
          <DataTablePagination
            page={deals.page}
            totalPages={deals.totalPages}
            total={deals.total}
            perPage={deals.perPage}
            pageKey="dealsPage"
            perPageKey="dealsPerPage"
          />
        </div>
      )}
    </div>
  );
}

function weekHint(status: CreatorDealStatus, start: Date, end: Date): string {
  const now = Date.now();
  const dayMs = 86_400_000;
  if (status === "scheduled") {
    const days = Math.max(1, Math.ceil((start.getTime() - now) / dayMs));
    return `starts in ${days}d`;
  }
  if (status === "active") {
    const days = Math.max(1, Math.ceil((end.getTime() - now) / dayMs));
    return `ends in ${days}d`;
  }
  return "7-day window";
}

// React.memo so a deal row doesn't re-render every time the parent's
// state (modal open, sibling tab pagination, etc.) changes — props are
// stable across parent renders since `deal` is the same reference from
// the server-rendered list.
const DealRow = memo(function DealRow({
  userId,
  deal,
}: {
  userId: string;
  deal: CreatorDealResponse;
}) {
  const canTerminate =
    deal.status === "scheduled" || deal.status === "active";
  const { start, end, hint } = useMemo(() => {
    const s = new Date(deal.week_start_utc);
    const e = new Date(deal.week_end_utc);
    return { start: s, end: e, hint: weekHint(deal.status, s, e) };
  }, [deal.week_start_utc, deal.week_end_utc, deal.status]);

  return (
    <TableRow>
      <TableCell className="pl-4">
        <div className="text-sm font-medium">
          {formatDate(start)} → {formatDate(end)}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={STATUS_STYLE[deal.status]}>
          {deal.status}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="font-medium">{deal.fills_used}</span>
        <span className="text-muted-foreground">/{deal.fills_allowed}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        ${deal.per_fill_amount_usd}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {(deal.conversion_rate_bps / 100).toFixed(1)}%
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <CapCell deal={deal} />
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">
          ${deal.max_tip_per_user_usd}
        </span>
        <span> / ${deal.max_tip_per_stream_usd}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">
          ${deal.max_sponsored_battle_usd}
        </span>
        <span> / ${deal.max_sponsorship_per_stream_usd}</span>
      </TableCell>
      <TableCell className="pr-2 text-right">
        {canTerminate && (
          <div className="flex items-center justify-end gap-1">
            <DealFormDialog userId={userId} mode="edit" deal={deal} />
            <TerminateDealButton userId={userId} deal={deal} />
          </div>
        )}
      </TableCell>
    </TableRow>
  );
});

const DealMobileCard = memo(function DealMobileCard({
  userId,
  deal,
}: {
  userId: string;
  deal: CreatorDealResponse;
}) {
  const canTerminate =
    deal.status === "scheduled" || deal.status === "active";
  const { start, end, hint } = useMemo(() => {
    const s = new Date(deal.week_start_utc);
    const e = new Date(deal.week_end_utc);
    return { start: s, end: e, hint: weekHint(deal.status, s, e) };
  }, [deal.week_start_utc, deal.week_end_utc, deal.status]);

  return (
    <div className="px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">
            {formatDate(start)} → {formatDate(end)}
          </div>
          <div className="text-[11px] text-muted-foreground">{hint}</div>
        </div>
        <Badge variant="outline" className={STATUS_STYLE[deal.status]}>
          {deal.status}
        </Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Fills
          </div>
          <div className="tabular-nums">
            <span className="font-medium">{deal.fills_used}</span>
            <span className="text-muted-foreground">/{deal.fills_allowed}</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Per fill
          </div>
          <div className="tabular-nums">${deal.per_fill_amount_usd}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Convert
          </div>
          <div className="tabular-nums">
            {(deal.conversion_rate_bps / 100).toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Withdraw cap
          </div>
          <div className="tabular-nums text-[11px]">
            <CapCell deal={deal} />
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Tip max (user / stream)
          </div>
          <div className="tabular-nums text-[11px]">
            ${deal.max_tip_per_user_usd} / ${deal.max_tip_per_stream_usd}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Sponsor max (battle / stream)
          </div>
          <div className="tabular-nums text-[11px]">
            ${deal.max_sponsored_battle_usd} / ${deal.max_sponsorship_per_stream_usd}
          </div>
        </div>
      </div>
      {canTerminate && (
        <div className="mt-2 flex items-center justify-end gap-1">
          <DealFormDialog userId={userId} mode="edit" deal={deal} />
          <TerminateDealButton userId={userId} deal={deal} />
        </div>
      )}
    </div>
  );
});

function CapCell({ deal }: { deal: CreatorDealResponse }) {
  const used = Number(deal.withdraw_cap_used_usd);
  if (deal.total_withdraw_cap_usd === null) {
    return (
      <div className="flex flex-col items-end">
        <span className="text-muted-foreground">Uncapped</span>
        {used > 0 && (
          <span className="text-[10px] text-muted-foreground/70">
            paid ${used.toFixed(2)}
          </span>
        )}
      </div>
    );
  }
  const total = Number(deal.total_withdraw_cap_usd);
  const remaining = Math.max(0, total - used);
  const exhausted = remaining <= 0 && total > 0;
  return (
    <div className="flex flex-col items-end">
      <span>
        <span
          className={cn(
            "font-medium",
            exhausted ? "text-rose-600 dark:text-rose-400" : undefined,
          )}
        >
          ${used.toFixed(2)}
        </span>
        <span className="text-muted-foreground">/${total.toFixed(2)}</span>
      </span>
      <span className="text-[10px] text-muted-foreground/70">
        {exhausted ? "cap reached" : `$${remaining.toFixed(2)} left`}
      </span>
    </div>
  );
}

function TerminateDealButton({
  userId,
  deal,
}: {
  userId: string;
  deal: CreatorDealResponse;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(options: { force_end_active_session: boolean }) {
    startTransition(async () => {
      try {
        await terminateCreatorDeal(userId, deal.id, {
          force_end_active_session: options.force_end_active_session,
          reason: "admin-terminated",
        });
        toast.success("Deal terminated");
        setOpen(false);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to terminate deal",
        );
      }
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-rose-600 hover:text-rose-700 hover:bg-rose-500/10"
        onClick={() => setOpen(true)}
      >
        <Ban className="mr-1.5 size-3.5" />
        Terminate
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Terminate this deal?</AlertDialogTitle>
            <AlertDialogDescription>
              The week&apos;s remaining unused fills will be forfeited and
              recorded on the ledger. If the creator has an active session
              on this deal, the terminate will be blocked unless you also
              force-end the session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              disabled={isPending}
              onClick={() =>
                handleConfirm({ force_end_active_session: true })
              }
              className="w-full sm:w-auto"
            >
              {isPending ? (
                <Loader2 className="mr-2 size-3.5 animate-spin" />
              ) : null}
              Terminate + force-end
            </Button>
            <AlertDialogAction
              disabled={isPending}
              onClick={() =>
                handleConfirm({ force_end_active_session: false })
              }
              className={cn(
                "bg-rose-600 text-white hover:bg-rose-700",
              )}
            >
              {isPending ? "Terminating..." : "Terminate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <PackageOpen className="size-4 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
