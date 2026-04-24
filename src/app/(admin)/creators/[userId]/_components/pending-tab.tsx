import { Coins } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils/format";
import type {
  PendingConversionResponse,
  PendingConversionStatus,
} from "@/lib/backend-api";

import { PendingStatusToggle } from "./pending-status-toggle";

type Props = {
  pending: PendingConversionResponse[];
  currentStatus: PendingConversionStatus;
};

/**
 * Read-only list of pending conversions (battle settlements that arrived
 * after the creator closed their stream). Admin can't claim on behalf of
 * the creator — claim endpoint is creator-only. This tab exists for
 * observability and as a reminder to re-promote a demoted creator before
 * they lose access to the amounts below.
 */
export function PendingTab({ pending, currentStatus }: Props) {
  const toggleRow = (
    <div className="flex items-center justify-between border-b px-4 py-2">
      <PendingStatusToggle value={currentStatus} />
      <p className="text-[11px] text-muted-foreground">
        {pending.length} row{pending.length === 1 ? "" : "s"}
      </p>
    </div>
  );

  if (pending.length === 0) {
    return (
      <div>
        {toggleRow}
        <EmptyState
          title={
            currentStatus === "claimed"
              ? "No claimed conversions yet"
              : "Nothing pending"
          }
          description={
            currentStatus === "claimed"
              ? "Converted amounts the creator already claimed appear here. Switch to Pending to see amounts still awaiting claim."
              : "Battle wins and refunds that arrive after a stream session ends appear here until the creator claims them. Conversion rate is locked at the source session's rate."
          }
        />
      </div>
    );
  }

  const total = pending.reduce((sum, p) => sum + Number(p.amount_usd), 0);

  return (
    <div>
      {toggleRow}

      <div className="flex items-baseline justify-between border-b bg-muted/20 px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {currentStatus === "claimed" ? "Total claimed" : "Total pending"}
          </span>
          <span className="text-base font-semibold tabular-nums">
            ${total.toFixed(2)}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {currentStatus === "claimed"
            ? "already claimed by creator"
            : "awaiting creator claim"}
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Source</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Locked rate</TableHead>
            <TableHead>Deal</TableHead>
            <TableHead>Session</TableHead>
            <TableHead className="pr-4">
              {currentStatus === "claimed" ? "Claimed" : "Recorded"}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pending.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="pl-4">
                <Badge variant="outline" className="font-mono text-[11px]">
                  {row.source}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                ${row.amount_usd}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {(row.conversion_rate_bps_snapshot / 100).toFixed(1)}%
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {row.deal_id.slice(0, 8)}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {row.session_id.slice(0, 8)}
              </TableCell>
              <TableCell className="pr-4 text-xs text-muted-foreground">
                {formatDateTime(
                  new Date(
                    currentStatus === "claimed" && row.claimed_at
                      ? row.claimed_at
                      : row.created_at,
                  ),
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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
        <Coins className="size-4 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
