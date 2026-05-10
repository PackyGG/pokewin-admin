"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { BorrowBadge } from "@/components/borrow-badge";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import type { BattleListItem } from "@/lib/queries/battles";
import { InlineCancelBattleButton } from "./inline-cancel-button";

const BATTLE_STATUS_COLORS: Record<string, string> = {
  waiting: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  animating: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export const columns: ColumnDef<BattleListItem>[] = [
  {
    accessorKey: "id",
    header: "ID",
    cell: ({ row }) => (
      <Link
        href={`/battles/${row.original.id}`}
        className="font-mono text-xs hover:underline"
      >
        {row.original.id.slice(0, 8)}...
      </Link>
    ),
  },
  {
    accessorKey: "username",
    header: "Creator",
    cell: ({ row }) => (
      <Link href={`/users/${row.original.userId}`} className="hover:underline">
        {row.original.username ?? row.original.userId.slice(0, 8)}
      </Link>
    ),
  },
  {
    accessorKey: "mode",
    header: "Mode",
    cell: ({ row }) => <Badge variant="outline">{row.original.mode}</Badge>,
  },
  {
    accessorKey: "teams",
    header: "Teams",
    cell: ({ row }) => `${row.original.teams} x ${row.original.playersPerTeam}`,
  },
  {
    accessorKey: "betAmount",
    header: "Bet",
    // Bet column doubles as the borrow surface — admins scanning the
    // table want to know "how much was bet AND was it borrowed" in
    // the same glance. Stacking the bet amount over the BorrowBadge
    // keeps the column compact and avoids adding a separate column.
    cell: ({ row }) => (
      <div className="flex flex-col items-start gap-0.5">
        <span className="tabular-nums">
          {formatCurrency(row.original.betAmount)}
        </span>
        <BorrowBadge
          percent={row.original.borrowPercentage}
          amountUsd={row.original.borrowedAmountUsd}
          size="sm"
        />
      </div>
    ),
  },
  {
    accessorKey: "totalPayout",
    header: "Payout",
    // Payout = what the house paid out to the winner(s). House loss → rose.
    cell: ({ row }) => {
      const p = row.original.totalPayout;
      if (p == null) return <span className="text-muted-foreground">—</span>;
      return (
        <span className="text-rose-600 dark:text-rose-400">
          {formatCurrency(p)}
        </span>
      );
    },
  },
  {
    accessorKey: "houseEdge",
    header: "House Edge",
    // House edge negative = house lost money on this battle → rose.
    cell: ({ row }) => {
      const he = row.original.houseEdge;
      if (he == null) return <span className="text-muted-foreground">—</span>;
      return (
        <span className={he < 0 ? "text-rose-600 dark:text-rose-400" : ""}>
          {he.toFixed(2)}%
        </span>
      );
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant="outline" className={BATTLE_STATUS_COLORS[row.original.status] ?? ""}>
        {row.original.status.replace(/_/g, " ")}
      </Badge>
    ),
  },
  {
    accessorKey: "regionCode",
    header: "Region",
    cell: ({ row }) => <Badge variant="outline">{row.original.regionCode}</Badge>,
  },
  {
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) => formatDateTime(row.original.createdAt),
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) =>
      row.original.status === "waiting" ? (
        <InlineCancelBattleButton battleId={row.original.id} />
      ) : null,
  },
];
