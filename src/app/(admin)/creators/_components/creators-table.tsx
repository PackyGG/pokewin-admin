"use client";

import Link from "next/link";
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
      return (
        <Link
          href={`/creators/${id}`}
          className="font-medium hover:underline"
        >
          {display}
        </Link>
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

export function CreatorsTable({ data }: { data: CreatorListItem[] }) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="rounded-md border">
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
  );
}
