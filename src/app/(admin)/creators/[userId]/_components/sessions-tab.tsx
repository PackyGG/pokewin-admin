"use client";

import { memo, useMemo, useState, useTransition } from "react";
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
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
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

      {/* Mobile card list (<lg) */}
      <div className="lg:hidden divide-y divide-border/60">
        {sessions.data.map((session) => (
          <SessionMobileCard
            key={session.id}
            userId={userId}
            session={session}
          />
        ))}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden overflow-x-auto lg:block">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Status</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">Loaded</TableHead>
            <TableHead className="text-right">Spent</TableHead>
            <TableHead className="text-right">Remaining</TableHead>
            <TableHead className="text-right">Converted</TableHead>
            <TableHead className="text-right">
              Spent on community
              <div className="text-[10px] font-normal normal-case text-muted-foreground/70">
                tips + sponsor
              </div>
            </TableHead>
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

// React.memo so a row doesn't re-render every time the parent's state
// (filter, pagination, sibling tables) changes — the row's own props are
// stable across renders since `session` references the same object from
// the server-rendered list. The formatted date is also memoized to avoid
// rebuilding the Date + locale string on every paint.
const SessionRow = memo(function SessionRow({
  userId,
  session,
}: {
  userId: string;
  session: CreatorSessionResponse;
}) {
  const activatedAt = useMemo(
    () => formatDateTime(new Date(session.activated_at)),
    [session.activated_at],
  );
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
        {activatedAt}
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
      {/* House-funded giveaways the creator handed out this session — the
          tips gifted + balance sponsored, both paid from house-provided
          fill. A real house outflow, so House-POV rose. */}
      <TableCell className="text-right tabular-nums">
        <CommunitySpend session={session} />
      </TableCell>
      <TableCell className="pr-2 text-right">
        {session.status === "active" && (
          <ForceEndButton userId={userId} sessionId={session.id} />
        )}
      </TableCell>
    </TableRow>
  );
});

const SessionMobileCard = memo(function SessionMobileCard({
  userId,
  session,
}: {
  userId: string;
  session: CreatorSessionResponse;
}) {
  const activatedAt = useMemo(
    () => formatDateTime(new Date(session.activated_at)),
    [session.activated_at],
  );
  return (
    <div className="px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {session.status === "active" && <LivePulse />}
          <Badge
            variant="outline"
            className={STATUS_STYLE[session.status]}
          >
            {session.status}
          </Badge>
        </div>
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
          {activatedAt}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Loaded
          </div>
          <div className="tabular-nums">${session.fill_loaded_usd}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Spent
          </div>
          <div className="tabular-nums text-muted-foreground">
            ${session.fill_spent_usd}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Remaining
          </div>
          <div className="tabular-nums">${session.fill_remaining_usd}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Converted
          </div>
          <div className="tabular-nums">
            {session.converted_to_raw_usd != null
              ? `$${session.converted_to_raw_usd}`
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Spent on community
          </div>
          <div className="tabular-nums">
            <CommunitySpend session={session} />
          </div>
        </div>
      </div>
      {session.status === "active" && (
        <div className="mt-2 flex justify-end">
          <ForceEndButton userId={userId} sessionId={session.id} />
        </div>
      )}
    </div>
  );
});

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

/**
 * The house-funded amount a creator handed to their community in one
 * session: the tips they gifted plus the balance they sponsored for
 * battles, both drawn from house-provided fill (§3 of the creator model).
 * Both arrive as decimal strings on the session object the list already
 * fetched — no extra round-trip.
 */
function sessionCommunitySpendUsd(session: CreatorSessionResponse): number {
  const tips = Number(session.tips_spent_this_session_usd);
  const sponsor = Number(session.sponsorship_spent_this_session_usd);
  return (Number.isFinite(tips) ? tips : 0) + (Number.isFinite(sponsor) ? sponsor : 0);
}

/**
 * Per-session community spend cell. House-POV: money the house funded and
 * the creator gave away, so a non-zero amount is rose; $0 reads muted "—".
 */
function CommunitySpend({ session }: { session: CreatorSessionResponse }) {
  const total = sessionCommunitySpendUsd(session);
  if (total <= 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="font-medium text-rose-600 dark:text-rose-400">
      {formatCurrency(total)}
    </span>
  );
}

function LivePulse() {
  // Honour prefers-reduced-motion: the outer pulse only animates on
  // motion-safe; reduce-motion users still see the solid amber dot but
  // without the constantly looping ping.
  return (
    <span className="relative flex size-2">
      <span className="absolute inline-flex size-full motion-safe:animate-ping rounded-full bg-amber-500 opacity-75" />
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
