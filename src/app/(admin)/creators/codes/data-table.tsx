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
import { Tag } from "lucide-react";
import { columns } from "./columns";
import type { CodeListItem } from "@/lib/queries/creators";
import { formatRelative } from "@/lib/utils/format";
import { MobileCard } from "@/components/data-table/mobile-card-list";

function CodeMobileCard({ code }: { code: CodeListItem }) {
  const router = useRouter();
  return (
    <MobileCard
      onClick={() => router.push(`/creators/codes/${code.code}`)}
      leading={
        <div className="flex size-9 items-center justify-center rounded-md bg-amber-500/10 shrink-0">
          <Tag className="size-4 text-amber-500" />
        </div>
      }
      primary={
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm">{code.code}</span>
          <Badge
            variant="outline"
            className={
              "h-4 px-1 text-[9px] " +
              (code.isActive
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30")
            }
          >
            {code.isActive ? "Active" : "Inactive"}
          </Badge>
        </span>
      }
      secondary={code.ownerUsername ?? code.ownerUserId.slice(0, 8)}
      footer={formatRelative(code.createdAt)}
      showChevron
    />
  );
}

export function CodesDataTable({ data }: { data: CodeListItem[] }) {
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
            No codes found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((code) => (
              <CodeMobileCard key={code.code} code={code} />
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
                  No codes found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
