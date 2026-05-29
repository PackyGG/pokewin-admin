"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { BorrowBadge } from "@/components/borrow-badge";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import {
  amountColorFor,
  amountSignFor,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import type { TransactionListItem } from "@/lib/queries/transactions";

// Type badge palette — purely semantic (identifies the ledger type at a
// glance). Not a P&L indicator. Types that already have an obvious
// directional mapping use the matching house-POV tone (emerald for
// deposits, rose for admin adjustments) so the table doesn't contradict
// the Amount column next to it.
const TYPE_COLORS: Record<string, string> = {
  deposit: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  pack_opening: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  battle_bet: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  card_sale: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  admin_balance_adjustment: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
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
    // Type column doubles as the borrow surface — pack_opening and
    // battle_bet rows render the BorrowBadge underneath the type
    // chip so the borrow signal sits next to the event identity.
    cell: ({ row }) => (
      <div className="flex flex-col items-start gap-0.5">
        <Badge variant="outline" className={TYPE_COLORS[row.original.type] ?? "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"}>
          {row.original.type.replace(/_/g, " ")}
        </Badge>
        <BorrowBadge
          percent={row.original.borrowPercentage}
          amountUsd={row.original.borrowedAmountUsd}
          size="sm"
        />
      </div>
    ),
  },
  {
    accessorKey: "amount",
    header: "Amount",
    // Colors come from the ledger TYPE, not the signed user-facing delta.
    // A wager and a withdrawal both decrease the user's balance, but only
    // one is a house loss — coloring by delta alone would paint them the
    // same. `ledgerDirection` is the single source of truth the rest of
    // the site uses (Recent Activity, user timelines, etc.).
    cell: ({ row }) => {
      const dir = ledgerDirection(row.original.type);
      return (
        <span className={amountColorFor(dir)}>
          {amountSignFor(dir)}
          {formatCurrency(Math.abs(row.original.amount))}
        </span>
      );
    },
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
    header: "Items Won",
    // Items Won = full value the user received on a game session =
    // cards + voucher excess (invariant). User won it → it left the
    // house → house loss → rose.
    cell: ({ row }) => {
      const p = row.original.payout;
      if (p == null) return <span className="text-muted-foreground">—</span>;
      return (
        <span className="text-rose-600 dark:text-rose-400">
          {formatCurrency(p)}
        </span>
      );
    },
  },
  {
    accessorKey: "housePnl",
    header: "House P&L",
    // Per-row house profit/loss in USD on a game session: bet − items
    // won (cards + vouchers). House POV: positive = house kept money
    // (emerald), negative = user pulled above bet (rose). Replaces the
    // old meaningless House Edge %.
    cell: ({ row }) => {
      const pnl = row.original.housePnl;
      if (pnl == null) return <span className="text-muted-foreground">—</span>;
      const positive = pnl >= 0;
      return (
        <span
          className={
            positive
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }
        >
          {positive ? "+" : "-"}
          {formatCurrency(Math.abs(pnl))}
        </span>
      );
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
