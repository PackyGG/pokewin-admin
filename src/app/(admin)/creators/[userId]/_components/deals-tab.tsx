"use client";

import { useState, useTransition } from "react";
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
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Week</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Fills</TableHead>
            <TableHead className="text-right">Per Fill</TableHead>
            <TableHead className="text-right">Convert</TableHead>
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

function DealRow({
  userId,
  deal,
}: {
  userId: string;
  deal: CreatorDealResponse;
}) {
  const canTerminate =
    deal.status === "scheduled" || deal.status === "active";
  const start = new Date(deal.week_start_utc);
  const end = new Date(deal.week_end_utc);
  const hint = weekHint(deal.status, start, end);

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
