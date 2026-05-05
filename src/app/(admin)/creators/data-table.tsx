"use client";

import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Crown } from "lucide-react";
import { columns } from "./columns";
import type { CreatorListItem } from "@/lib/queries/creators";
import { formatCurrency } from "@/lib/utils/format";
import { InlinePayoutButton } from "./inline-payout-button";

function CreatorMobileCard({ creator }: { creator: CreatorListItem }) {
  const router = useRouter();
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3 hover:bg-muted/40 transition-colors">
      <button
        type="button"
        onClick={() => router.push(`/creators/${creator.userId}`)}
        className="flex w-full items-center gap-3 text-left min-w-0"
      >
        <div className="flex size-9 items-center justify-center rounded-md bg-amber-500/10 shrink-0">
          <Crown className="size-4 text-amber-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-tight">
            {creator.username ?? creator.userId.slice(0, 8)}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2 truncate">
            <span className="font-mono">{creator.code}</span>
            <span>• Lv {creator.level}</span>
            <span>• {creator.totalSignups} signups</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          {/* Available = unpaid creator earnings → house liability → rose. */}
          <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(creator.availableUsd)}
          </div>
          <div className="text-[10px] text-muted-foreground tabular-nums">
            {formatCurrency(creator.totalEarnedUsd)} earned
          </div>
        </div>
      </button>
      {creator.availableUsd > 0 && (
        <div className="mt-2 flex justify-end">
          <InlinePayoutButton
            userId={creator.userId}
            availableUsd={creator.availableUsd}
          />
        </div>
      )}
    </div>
  );
}

export function CreatorsDataTable({ data }: { data: CreatorListItem[] }) {
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
              <CreatorMobileCard key={creator.userId} creator={creator} />
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
                      : flexRender(header.column.columnDef.header, header.getContext())}
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
                <TableCell colSpan={columns.length} className="h-24 text-center">
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
