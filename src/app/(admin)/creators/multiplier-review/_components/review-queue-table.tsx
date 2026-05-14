"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Flag,
} from "lucide-react";

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
import { formatRelative } from "@/lib/utils/format";
import type { MultiplierDealResponse } from "@/lib/backend-api";

import { MultiplierDealDetailDrawer } from "../../_components/multiplier-review/deal-detail-drawer";
import {
  MULTIPLIER_STATUS_BADGE,
  MULTIPLIER_STATUS_LABEL,
  formatBps,
  formatStringUsd,
} from "../../_components/multiplier-review/shared";

type Props = {
  deals: MultiplierDealResponse[];
  total: number;
  offset: number;
  pageSize: number;
  flaggedOnly: boolean;
};

/**
 * Review queue table. Row click opens the detail drawer which has all
 * the action surface. Pagination via offset query param so server
 * components re-fetch the next slice from the backend.
 *
 * "Creator" column shows just the user_id — we don't have a cheap way
 * to bulk-resolve usernames here without a separate query batch. Each
 * row links to the creator detail page where the full context lives.
 */
export function ReviewQueueTable({
  deals,
  total,
  offset,
  pageSize,
  flaggedOnly,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [drawerDeal, setDrawerDeal] =
    useState<MultiplierDealResponse | null>(null);

  if (deals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <AlertTriangle className="size-5 text-muted-foreground" />
        </div>
        <div>
          <div className="text-sm font-medium">
            {flaggedOnly
              ? "No flagged deals"
              : "No deals awaiting review"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {flaggedOnly
              ? "Everything in the queue has cleared auto-flag checks."
              : "All settled streams have been approved or rejected."}
          </div>
        </div>
      </div>
    );
  }

  function gotoOffset(nextOffset: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextOffset === 0) {
      params.delete("offset");
    } else {
      params.set("offset", String(nextOffset));
    }
    const qs = params.toString();
    router.push(qs ? `?${qs}` : "?", { scroll: false });
  }

  const start = offset + 1;
  const end = Math.min(offset + deals.length, total);
  const hasPrev = offset > 0;
  const hasNext = offset + deals.length < total;

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Status</TableHead>
              <TableHead>Creator</TableHead>
              <TableHead className="text-right">Ending balance</TableHead>
              <TableHead className="text-right">Withdrawable</TableHead>
              <TableHead className="text-right">Bets</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead>Ended</TableHead>
              <TableHead className="pr-4 text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deals.map((deal) => {
              const flagCount = deal.flagged_reasons?.length ?? 0;
              const calcPayout = deal.ending_balance_usd
                ? (
                    (Number(deal.ending_balance_usd) *
                      deal.withdrawable_bps) /
                    10000
                  ).toFixed(2)
                : null;
              return (
                <TableRow
                  key={deal.id}
                  className="cursor-pointer"
                  onClick={() => setDrawerDeal(deal)}
                >
                  <TableCell className="pl-4">
                    <Badge
                      variant="outline"
                      className={MULTIPLIER_STATUS_BADGE[deal.status]}
                    >
                      {MULTIPLIER_STATUS_LABEL[deal.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/creators/${deal.user_id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 font-mono text-xs text-blue-500 hover:underline"
                    >
                      {deal.user_id.slice(0, 12)}…
                      <ExternalLink className="size-3" />
                    </Link>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {formatStringUsd(deal.ending_balance_usd)}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {calcPayout ? (
                      <span className="text-rose-500">
                        {formatStringUsd(calcPayout)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    <div className="text-[10px] text-muted-foreground">
                      {formatBps(deal.withdrawable_bps)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {deal.bet_count}
                  </TableCell>
                  <TableCell>
                    {flagCount > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs text-orange-500">
                        <Flag className="size-3" />
                        {flagCount}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        —
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {deal.ended_at
                        ? formatRelative(deal.ended_at)
                        : "—"}
                    </span>
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          {start}–{end} of {total}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasPrev}
            onClick={() => gotoOffset(Math.max(0, offset - pageSize))}
          >
            <ChevronLeft className="size-3.5" />
            Prev
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasNext}
            onClick={() => gotoOffset(offset + pageSize)}
          >
            Next
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>

      <MultiplierDealDetailDrawer
        deal={drawerDeal}
        open={drawerDeal !== null}
        onOpenChange={(o) => {
          if (!o) setDrawerDeal(null);
        }}
        onActionSuccess={() => router.refresh()}
      />
    </>
  );
}
