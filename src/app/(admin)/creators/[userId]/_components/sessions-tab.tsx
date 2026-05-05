"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Activity, Loader2, OctagonX } from "lucide-react";

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
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/utils/format";
import type {
  CreatorSessionResponse,
  StreamSessionStatus,
} from "@/lib/backend-api";

import type { PaginatedSlice } from "../_lib/types";

import { forceEndCreatorSession } from "../../backend-actions";
import { SessionsStatusFilter } from "./sessions-status-filter";

const STATUS_STYLE: Record<StreamSessionStatus, string> = {
  active:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  ended: "border-muted bg-muted/50 text-muted-foreground",
  converted:
    "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
};

type Props = {
  userId: string;
  sessions: PaginatedSlice<CreatorSessionResponse>;
  currentStatus: StreamSessionStatus | undefined;
};

export function SessionsTab({ userId, sessions, currentStatus }: Props) {
  const filterRow = (
    <div className="flex items-center justify-between border-b px-4 py-2">
      <SessionsStatusFilter value={currentStatus} />
      <p className="text-[11px] text-muted-foreground">
        {sessions.total} total
      </p>
    </div>
  );

  if (sessions.total === 0) {
    return (
      <div>
        {filterRow}
        <EmptyState
          title={
            currentStatus
              ? `No ${currentStatus} sessions`
              : "No stream sessions yet"
          }
          description={
            currentStatus
              ? "Try clearing the status filter to see all sessions."
              : "Stream sessions appear here once the creator activates a fill. Each row shows fill loaded, spent, converted, and elapsed time."
          }
        />
      </div>
    );
  }

  return (
    <div>
      {filterRow}

      <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Status</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">Loaded</TableHead>
            <TableHead className="text-right">Spent</TableHead>
            <TableHead className="text-right">Remaining</TableHead>
            <TableHead className="text-right">Converted</TableHead>
            <TableHead className="pr-4 text-right"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.data.map((session) => (
            <SessionRow
              key={session.id}
              userId={userId}
              session={session}
            />
          ))}
        </TableBody>
      </Table>
      </div>

      {sessions.totalPages > 1 && (
        <div className="border-t px-4">
          <DataTablePagination
            page={sessions.page}
            totalPages={sessions.totalPages}
            total={sessions.total}
            perPage={sessions.perPage}
            pageKey="sessionsPage"
            perPageKey="sessionsPerPage"
          />
        </div>
      )}
    </div>
  );
}

function SessionRow({
  userId,
  session,
}: {
  userId: string;
  session: CreatorSessionResponse;
}) {
  return (
    <TableRow>
      <TableCell className="pl-4">
        <div className="flex items-center gap-2">
          {session.status === "active" && <LivePulse />}
          <Badge variant="outline" className={STATUS_STYLE[session.status]}>
            {session.status}
          </Badge>
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatDateTime(new Date(session.activated_at))}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        ${session.fill_loaded_usd}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        ${session.fill_spent_usd}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        ${session.fill_remaining_usd}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {session.converted_to_raw_usd != null
          ? `$${session.converted_to_raw_usd}`
          : "—"}
      </TableCell>
      <TableCell className="pr-2 text-right">
        {session.status === "active" && (
          <ForceEndButton userId={userId} sessionId={session.id} />
        )}
      </TableCell>
    </TableRow>
  );
}

function ForceEndButton({
  userId,
  sessionId,
}: {
  userId: string;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      try {
        await forceEndCreatorSession(userId, sessionId, {
          reason: "admin-force-end",
        });
        toast.success("Session force-ended");
        setOpen(false);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to end session",
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
        <OctagonX className="mr-1.5 size-3.5" />
        Force-end
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force-end this session?</AlertDialogTitle>
            <AlertDialogDescription>
              The session will end exactly as if the creator clicked end
              themselves: inventory liquidated, vouchers redeemed, fill
              balance converted at the locked rate, and a payout voucher
              issued. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={handleConfirm}
              className={cn("bg-rose-600 text-white hover:bg-rose-700")}
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-2 size-3.5 animate-spin" />
                  Ending...
                </>
              ) : (
                "Force-end"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function LivePulse() {
  return (
    <span className="relative flex size-2">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500 opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
    </span>
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
        <Activity className="size-4 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
