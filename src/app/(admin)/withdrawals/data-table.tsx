"use client";

import { useRouter } from "next/navigation";
import {
  ColumnDef,
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import type { WithdrawalListItem } from "@/lib/queries/withdrawals";
import { EmptyState } from "@/components/empty-state";
import { ArrowUpFromLine } from "lucide-react";

interface WithdrawalsDataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
}

function initialsFor(username: string | null, userId: string): string {
  const src = username ?? userId;
  return src.slice(0, 2).toUpperCase();
}

function WithdrawalMobileCard({ wd }: { wd: WithdrawalListItem }) {
  const router = useRouter();
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => router.push(`/withdrawals/${wd.id}`)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left min-h-[56px] hover:bg-muted/40 active:bg-muted/60 transition-colors min-w-0"
      >
        <Avatar className="size-9 shrink-0">
          {wd.image && <AvatarImage src={wd.image} alt="" />}
          <AvatarFallback className="text-[10px]">
            {initialsFor(wd.username, wd.userId)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {wd.username ?? wd.userId.slice(0, 8)}
            </span>
            <Badge
              variant="outline"
              className={
                "h-4 px-1 text-[9px] capitalize " +
                (STATUS_COLORS[wd.status] ?? "")
              }
            >
              {wd.status}
            </Badge>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
            <Badge variant="outline" className="h-3.5 px-1 text-[9px] capitalize">
              {wd.method}
            </Badge>
            {/* Crypto asset chip alongside the method so the chain is
                visible at a glance on phone — same pattern as the
                desktop "Crypto" column. Physical-method rows have a
                null asset and the chip is just omitted. */}
            {wd.cryptoAsset && (
              <Badge variant="outline" className="h-3.5 px-1 font-mono text-[9px]">
                {wd.cryptoAsset}
              </Badge>
            )}
            <span>{wd.itemCount} item{wd.itemCount !== 1 ? "s" : ""}</span>
            <span>•</span>
            <span>{formatRelative(wd.requestedAt)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          {/* House-POV: a withdrawal value = money the user takes from the
              house → house loss → rose. */}
          <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(wd.totalValueUsd)}
          </div>
        </div>
      </button>
    </div>
  );
}

export function WithdrawalsDataTable<T>({ columns, data }: WithdrawalsDataTableProps<T>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  // We only render the mobile card list when T = WithdrawalListItem (the
  // production usage). The shape is the same in every caller; cast at the
  // boundary to keep the component generic while still rendering correct
  // mobile slots.
  const mobileItems = data as unknown as WithdrawalListItem[];

  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {mobileItems.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={ArrowUpFromLine}
              title="No withdrawals found"
              description="No withdrawal requests match the current filters. Try a different status, method, or value range."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {mobileItems.map((wd) => (
              <WithdrawalMobileCard key={wd.id} wd={wd} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        {/* Zebra striping makes the dense Withdrawals row set easier to
            scan across the 8 columns — hover still wins because it uses
            muted/50 vs the stripe's muted/30. */}
        <Table zebra>
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
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-0">
                  <EmptyState
                    icon={ArrowUpFromLine}
                    title="No withdrawals found"
                    description="No withdrawal requests match the current filters. Try a different status, method, or value range."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
