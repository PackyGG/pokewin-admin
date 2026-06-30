"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";
import { RelativeTime } from "@/components/relative-time";
import {
  DoubleDownResultBadge,
  DoubleDownStatusBadge,
} from "@/components/double-down/dd-badges";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { DoubleDownLog } from "@/lib/queries/double-down-shared";

/**
 * Full Double Down audit log table for /insights/double-down — every started
 * round, newest first. Server-driven pagination via `?page=` (the rows are
 * already the active server page; this only renders + paginates them).
 * House-POV money (CLAUDE.md): the payout to a winner = house cost (rose).
 * Staked is the neutral amount put up. There is NO "house cut" column — the
 * house edge is in the win probability, not a per-round cut.
 *
 * Only serializable props cross the RSC boundary (the row objects + a search
 * string); no function props.
 */
export function DoubleDownLogTable({
  log,
  search,
}: {
  log: DoubleDownLog;
  search: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function pageHref(p: number): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    return `${pathname}?${params.toString()}`;
  }

  const { rows, page, totalPages, total } = log;
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Battle</TableHead>
              <TableHead className="text-right">Staked</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="text-right">Payout</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {search
                    ? `No Double Down rounds for "${search}" in this window.`
                    : "No Double Down rounds in this window."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    <RelativeTime date={r.createdAt} />
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate">
                    <Link
                      href={`/users/${r.userId}`}
                      className="font-medium text-foreground hover:underline"
                    >
                      {r.username ?? r.userId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">
                    <a
                      href={`https://packy.gg/games/battles/${r.battleId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                      title={r.battleId}
                    >
                      {r.battleId.slice(0, 8)}
                      <ExternalLink className="size-3" />
                    </a>
                  </TableCell>
                  {/* Staked = the winnings the user put up. Neutral. */}
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(r.stakedUsd)}
                  </TableCell>
                  <TableCell>
                    <DoubleDownResultBadge result={r.result} />
                  </TableCell>
                  {/* Payout to a winner = house COST → rose. */}
                  <TableCell className="text-right tabular-nums">
                    {r.result === "win" && r.payoutUsd != null ? (
                      <span className="font-semibold text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.payoutUsd)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <DoubleDownStatusBadge status={r.status} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {formatNumber(total)} {total === 1 ? "round" : "rounds"} · page {page}{" "}
          of {totalPages}
        </span>
        <div className="flex items-center gap-2">
          {hasPrev ? (
            <Link
              href={pageHref(page - 1)}
              replace
              prefetch={false}
              scroll={false}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
            >
              <ChevronLeft className="size-4" />
              Prev
            </Link>
          ) : (
            <span
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "gap-1 pointer-events-none opacity-50",
              )}
              aria-disabled
            >
              <ChevronLeft className="size-4" />
              Prev
            </span>
          )}
          {hasNext ? (
            <Link
              href={pageHref(page + 1)}
              replace
              prefetch={false}
              scroll={false}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
            >
              Next
              <ChevronRight className="size-4" />
            </Link>
          ) : (
            <span
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "gap-1 pointer-events-none opacity-50",
              )}
              aria-disabled
            >
              Next
              <ChevronRight className="size-4" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
