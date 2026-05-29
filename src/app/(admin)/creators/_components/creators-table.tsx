"use client";

import Link from "next/link";
import { Crown } from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatNumber } from "@/lib/utils/format";
import type { CreatorListItem, CreatorDealStatus } from "@/lib/backend-api";

import { CreatorRowActions } from "./creator-row-actions";

const DEAL_STATUS_STYLE: Record<CreatorDealStatus, string> = {
  scheduled: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  completed: "border-muted bg-muted/50 text-muted-foreground",
  terminated: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
};

const columns: ColumnDef<CreatorListItem>[] = [
  {
    accessorKey: "username",
    header: "User",
    cell: ({ row }) => {
      const { id, username, email } = row.original;
      const display = username ?? email ?? id.slice(0, 8);
      const hasActiveDeal =
        row.original.current_deal?.status === "active";
      return (
        <div className="flex items-center gap-2">
          {/* Steady emerald dot when the creator has a deal in the
              active state right now. Lets admins scan the table for
              creators currently mid-deal without reading the This
              Week column. Distinct from the Streaming column's
              pulsing dot — that one fires on active_session_id. */}
          {hasActiveDeal && (
            <span
              className="relative inline-flex size-2 shrink-0 rounded-full bg-emerald-500"
              aria-label="Active deal"
              title="Deal is currently active this week"
            />
          )}
          <Link
            href={`/creators/${id}`}
            className="font-medium hover:underline"
          >
            {display}
          </Link>
        </div>
      );
    },
  },
  {
    accessorKey: "created_at",
    header: "Creator Since",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatDate(new Date(row.original.created_at))}
      </span>
    ),
  },
  {
    id: "this_week",
    header: "This Week",
    cell: ({ row }) => {
      const deal = row.original.current_deal;
      if (!deal) {
        return <span className="text-xs text-muted-foreground">No deal</span>;
      }
      return (
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline" className={DEAL_STATUS_STYLE[deal.status]}>
            {deal.status}
          </Badge>
          <span className="font-mono">
            {deal.fills_used}/{deal.fills_allowed}
          </span>
          <span className="text-muted-foreground">
            × ${deal.per_fill_amount_usd}
          </span>
        </div>
      );
    },
  },
  {
    id: "streaming",
    header: "Streaming",
    cell: ({ row }) => {
      const live = row.original.active_session_id !== null;
      return live ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          Live
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      );
    },
  },
  {
    accessorKey: "total_deals_count",
    header: "Deals",
    cell: ({ row }) => (
      <span className="font-mono text-sm">
        {formatNumber(row.original.total_deals_count)}
      </span>
    ),
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => (
      <CreatorRowActions
        userId={row.original.id}
        hasActiveSession={row.original.active_session_id !== null}
        hasActiveDeal={
          row.original.current_deal?.status === "active" ||
          row.original.current_deal?.status === "scheduled"
        }
      />
    ),
  },
];

function CreatorMobileCard({ creator }: { creator: CreatorListItem }) {
  const display =
    creator.username ?? creator.email ?? creator.id.slice(0, 8);
  const live = creator.active_session_id !== null;
  const deal = creator.current_deal;
  const hasActiveDeal = deal?.status === "active";
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-amber-500/10 shrink-0">
          <Crown className="size-4 text-amber-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/creators/${creator.id}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {display}
            </Link>
            {hasActiveDeal && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400"
                title="Deal is currently active this week"
              >
                <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                Active
              </span>
            )}
            {live && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                </span>
                Live
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Since {formatDate(new Date(creator.created_at))}
            {" · "}
            {formatNumber(creator.total_deals_count)} deals
          </div>
          {deal && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
              <Badge
                variant="outline"
                className={"h-4 px-1 text-[9px] " + DEAL_STATUS_STYLE[deal.status]}
              >
                {deal.status}
              </Badge>
              <span className="font-mono text-muted-foreground">
                {deal.fills_used}/{deal.fills_allowed}
              </span>
              <span className="text-muted-foreground">
                × ${deal.per_fill_amount_usd}
              </span>
            </div>
          )}
        </div>
        <div className="shrink-0">
          <CreatorRowActions
            userId={creator.id}
            hasActiveSession={live}
            hasActiveDeal={
              deal?.status === "active" || deal?.status === "scheduled"
            }
          />
        </div>
      </div>
    </div>
  );
}

export function CreatorsTable({ data }: { data: CreatorListItem[] }) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
            No creators found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((creator) => (
              <CreatorMobileCard key={creator.id} creator={creator} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  No creators found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
