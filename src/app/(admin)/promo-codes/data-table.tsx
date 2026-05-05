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
import { Ticket } from "lucide-react";
import { columns } from "./columns";
import type { PromoCodeListItem } from "@/lib/queries/promo-codes";
import { formatCurrency } from "@/lib/utils/format";
import { MobileCard } from "@/components/data-table/mobile-card-list";

function codeStatus(row: PromoCodeListItem): { label: string; cls: string } {
  const isExpired = row.expiresAt && new Date(row.expiresAt) < new Date();
  const isUsedUp = row.redemptionCount >= row.maxUses;
  if (isExpired)
    return {
      label: "Expired",
      cls: "border-rose-500/30 bg-rose-500/15 text-rose-400",
    };
  if (isUsedUp)
    return {
      label: "Used up",
      cls: "border-amber-500/30 bg-amber-500/15 text-amber-400",
    };
  return {
    label: "Active",
    cls: "border-emerald-500/30 bg-emerald-500/15 text-emerald-400",
  };
}

function PromoMobileCard({ code }: { code: PromoCodeListItem }) {
  const router = useRouter();
  const status = codeStatus(code);
  const display = code.code ?? code.codeHash.slice(0, 12) + "…";
  return (
    <MobileCard
      onClick={() => router.push(`/promo-codes/${code.id}`)}
      leading={
        <div className="flex size-9 items-center justify-center rounded-md bg-amber-500/10 shrink-0">
          <Ticket className="size-4 text-amber-500" />
        </div>
      }
      primary={
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm">{display}</span>
          <Badge variant="outline" className={"h-4 px-1 text-[9px] " + status.cls}>
            {status.label}
          </Badge>
        </span>
      }
      secondary={
        <span>
          Min level {code.minimumLevel} · {code.redemptionCount}/{code.maxUses} used
        </span>
      }
      trailing={
        <div>
          {/* House-POV: promo value is house-paid credit → house liability → rose. */}
          <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(code.value)}
          </div>
        </div>
      }
      showChevron
    />
  );
}

export function PromoCodesDataTable({ data }: { data: PromoCodeListItem[] }) {
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
            No promo codes found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((code) => (
              <PromoMobileCard key={code.id} code={code} />
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
                  No promo codes found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
