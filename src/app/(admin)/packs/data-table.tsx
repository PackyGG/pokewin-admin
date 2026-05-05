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
import { Badge } from "@/components/ui/badge";
import { columns } from "./columns";
import type { PackListItem } from "@/lib/queries/packs";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { MobileCard } from "@/components/data-table/mobile-card-list";
import { Package } from "lucide-react";

function PackMobileCard({ pack }: { pack: PackListItem }) {
  const router = useRouter();
  const rtpRaw = pack.actualRtp;
  const rtpPct = rtpRaw > 2 ? rtpRaw : rtpRaw * 100;
  return (
    <MobileCard
      onClick={() => router.push(`/packs/${pack.id}`)}
      leading={
        <div className="flex size-9 items-center justify-center rounded-md bg-blue-500/10 shrink-0">
          <Package className="size-4 text-blue-500" />
        </div>
      }
      primary={
        <span className="flex items-center gap-2">
          <span className="truncate">{pack.name}</span>
          <Badge
            variant="outline"
            className={
              "h-4 px-1 text-[9px] " +
              (pack.active
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30")
            }
          >
            {pack.active ? "Active" : "Inactive"}
          </Badge>
        </span>
      }
      secondary={
        <span className="font-mono">
          {pack.slug}
        </span>
      }
      trailing={
        <div className="flex flex-col items-end">
          <span className="text-sm font-medium tabular-nums">
            {formatCurrency(pack.priceUsd)}
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {rtpPct.toFixed(1)}% RTP
          </span>
        </div>
      }
      meta={[
        <span key="opens" className="tabular-nums">
          {formatNumber(pack.totalOpenings)} opens
        </span>,
        <span key="rev" className="tabular-nums">
          {formatCurrency(pack.totalRevenue)} rev
        </span>,
      ]}
      showChevron
    />
  );
}

export function PacksDataTable({ data }: { data: PackListItem[] }) {
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
            No packs found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((pack) => (
              <PackMobileCard key={pack.id} pack={pack} />
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
                  No packs found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
