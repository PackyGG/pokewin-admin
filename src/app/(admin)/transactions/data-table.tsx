"use client";

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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { columns as defaultColumns } from "./columns";
import type { TransactionListItem } from "@/lib/queries/transactions";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import {
  amountColorFor,
  amountSignFor,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import { MobileCard } from "@/components/data-table/mobile-card-list";
import { EmptyState } from "@/components/empty-state";
import { Receipt } from "lucide-react";
import { useRouter } from "next/navigation";

const TYPE_COLORS: Record<string, string> = {
  deposit:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  pack_opening: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  battle_bet: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  card_sale: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  admin_balance_adjustment:
    "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

function initialsFor(username: string | null, userId: string): string {
  const src = username ?? userId;
  return src.slice(0, 2).toUpperCase();
}

function TransactionMobileCard({ tx }: { tx: TransactionListItem }) {
  const router = useRouter();
  const dir = ledgerDirection(tx.type);
  const amountClass = amountColorFor(dir);
  const sign = amountSignFor(dir);
  const typeLabel = tx.type.replace(/_/g, " ");
  return (
    <MobileCard
      onClick={() => router.push(`/transactions/${tx.id}`)}
      leading={
        <Avatar className="size-9 shrink-0">
          {tx.image && <AvatarImage src={tx.image} alt="" />}
          <AvatarFallback className="text-[10px]">
            {initialsFor(tx.username, tx.userId)}
          </AvatarFallback>
        </Avatar>
      }
      primary={
        <span className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              "h-4 px-1.5 text-[9px] capitalize " +
              (TYPE_COLORS[tx.type] ??
                "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30")
            }
          >
            {typeLabel}
          </Badge>
          <span className="truncate text-xs text-muted-foreground">
            {tx.username ?? tx.userId.slice(0, 8)}
          </span>
        </span>
      }
      secondary={
        <span className="font-mono text-[10px]">
          {tx.id.slice(0, 12)}…
        </span>
      }
      trailing={
        <div className="flex flex-col items-end">
          <span className={"text-sm font-medium tabular-nums " + amountClass}>
            {sign}
            {formatCurrency(Math.abs(tx.amount))}
          </span>
          <Badge
            variant="outline"
            className={"mt-1 h-4 px-1 text-[9px] " + (STATUS_COLORS[tx.status] ?? "")}
          >
            {tx.status}
          </Badge>
        </div>
      }
      footer={formatRelative(tx.createdAt)}
      showChevron
    />
  );
}

export function TransactionsDataTable({
  data,
  columns,
}: {
  data: TransactionListItem[];
  columns?: ColumnDef<TransactionListItem>[];
}) {
  const resolvedColumns = columns ?? defaultColumns;
  const table = useReactTable({
    data,
    columns: resolvedColumns,
    getCoreRowModel: getCoreRowModel(),
    // Key rows by stable tx id (matches the users table) so React reuses
    // row nodes across pages instead of churning on positional index keys.
    getRowId: (r) => r.id,
  });

  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Receipt}
              title="No transactions found"
              description="No ledger entries match the current filters. Try a different status, type, or value range."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((tx) => (
              <TransactionMobileCard key={tx.id} tx={tx} />
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
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={resolvedColumns.length} className="p-0">
                  <EmptyState
                    icon={Receipt}
                    title="No transactions found"
                    description="No ledger entries match the current filters. Try a different status, type, or value range."
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

