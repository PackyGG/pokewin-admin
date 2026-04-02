"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import type { TransactionListItem } from "@/lib/queries/transactions";

const TYPE_COLORS: Record<string, string> = {
  deposit: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  pack_opening: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  battle_bet: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  card_sale: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  admin_balance_adjustment: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

export const columns: ColumnDef<TransactionListItem>[] = [
  {
    accessorKey: "id",
    header: "ID",
    cell: ({ row }) => (
      <Link
        href={`/transactions/${row.original.id}`}
        className="font-mono text-xs hover:underline"
      >
        {row.original.id.slice(0, 8)}...
      </Link>
    ),
  },
  {
    accessorKey: "username",
    header: "User",
    cell: ({ row }) => (
      <Link
        href={`/users/${row.original.userId}`}
        className="hover:underline"
      >
        {row.original.username ?? row.original.userId.slice(0, 8)}
      </Link>
    ),
  },
  {
    accessorKey: "type",
    header: "Type",
    cell: ({ row }) => (
      <Badge variant="outline" className={TYPE_COLORS[row.original.type] ?? "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"}>
        {row.original.type.replace(/_/g, " ")}
      </Badge>
    ),
  },
  {
    accessorKey: "amount",
    header: "Amount",
    cell: ({ row }) => (
      <span className={row.original.amount >= 0 ? "text-green-400" : "text-red-400"}>
        {row.original.amount >= 0 ? "+" : ""}{formatCurrency(row.original.amount)}
      </span>
    ),
  },
  {
    accessorKey: "balanceBefore",
    header: "Before",
    cell: ({ row }) => formatCurrency(row.original.balanceBefore),
  },
  {
    accessorKey: "balanceAfter",
    header: "After",
    cell: ({ row }) => formatCurrency(row.original.balanceAfter),
  },
  {
    accessorKey: "payout",
    header: "Payout",
    cell: ({ row }) => {
      const p = row.original.payout;
      if (p == null) return <span className="text-muted-foreground">—</span>;
      return <span className="text-green-400">{formatCurrency(p)}</span>;
    },
  },
  {
    accessorKey: "houseEdge",
    header: "House Edge",
    cell: ({ row }) => {
      const he = row.original.houseEdge;
      if (he == null) return <span className="text-muted-foreground">—</span>;
      return <span>{he.toFixed(2)}%</span>;
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant="outline" className={STATUS_COLORS[row.original.status] ?? ""}>
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) => formatDateTime(row.original.createdAt),
  },
];
