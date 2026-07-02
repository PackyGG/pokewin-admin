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
  balanceMovementSign,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import { ledgerTypeLabel } from "@/lib/utils/ledger-labels";
import { formatUpgraderMultiplier } from "@/lib/utils/upgrader-metadata";
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
  // Challenge prize = money paid to the user → house cost → rose.
  challenge_prize:
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
  // Color house-POV (by type); sign from the real balance movement (amount IS
  // the balanceAfter − balanceBefore delta) so a credit reads "+" regardless.
  const sign = balanceMovementSign(tx.balanceBefore, tx.balanceAfter);
  const typeLabel = ledgerTypeLabel(tx.type);
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
                "bg-muted text-muted-foreground border-border")
            }
          >
            {typeLabel}
          </Badge>
          {/* Target multiplier badge for upgrader_bet rows — mirrors
              the desktop columns Type cell so the phone view reads
              "user aimed at 5×" without clicking through. Hidden
              when the parser couldn't resolve a multiplier. */}
          {tx.type === "upgrader_bet" && tx.upgraderTargetMultiplier != null && (
            <span
              className="inline-flex items-center rounded border border-cyan-500/30 bg-cyan-500/15 px-1.5 py-0 text-[9px] font-medium text-cyan-600 dark:text-cyan-400"
              title="Target multiplier the user picked before the spin"
            >
              ⇡ {formatUpgraderMultiplier(tx.upgraderTargetMultiplier)}
            </span>
          )}
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
        {/* Zebra striping — transactions list runs hundreds of rows
            with similar shape (id / user / type / amount / timestamp),
            so an alternating row tint is the cheapest scan aid. */}
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

