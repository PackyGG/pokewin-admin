"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import type { WithdrawalListItem } from "@/lib/queries/withdrawals";
import { WithdrawalRowActions } from "./row-actions";

// Initials fallback for users without a profile picture — mirrors the
// pattern used in src/app/(admin)/transactions/deposits/columns.tsx.
function initialsFor(username: string | null, userId: string): string {
  const src = username ?? userId;
  return src.slice(0, 2).toUpperCase();
}

/**
 * Unified column set for the single-page Withdrawals view. Replaces the
 * old tab-specific column arrays (requestColumns, shippingRequestColumns,
 * finishedColumns, activeShipmentColumns) — one table now shows every
 * withdrawal regardless of status, matching the Deposits page layout.
 *
 * Per-row actions adapt to the withdrawal status and method via
 * WithdrawalRowActions. The Handled By / Tracking / Reason columns only
 * render when the row actually has that data, so they stay informational
 * without adding visual noise to pending rows.
 */
export const columns: ColumnDef<WithdrawalListItem, unknown>[] = [
  {
    accessorKey: "id",
    header: "ID",
    cell: ({ row }) => (
      <Link
        href={`/withdrawals/${row.original.id}`}
        className="font-mono text-xs hover:underline"
      >
        {row.original.id.slice(0, 8)}...
      </Link>
    ),
  },
  {
    accessorKey: "username",
    header: "User",
    cell: ({ row }) => {
      const { userId, username, image } = row.original;
      const label = username ?? userId.slice(0, 8);
      return (
        <Link
          href={`/users/${userId}`}
          className="flex items-center gap-2 hover:underline"
        >
          <Avatar size="sm" className="shrink-0">
            {image && <AvatarImage src={image} alt="" />}
            <AvatarFallback className="text-[10px]">
              {initialsFor(username, userId)}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{label}</span>
        </Link>
      );
    },
  },
  {
    accessorKey: "method",
    header: "Method",
    cell: ({ row }) => <Badge variant="outline">{row.original.method}</Badge>,
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge
        variant="outline"
        className={STATUS_COLORS[row.original.status] ?? ""}
      >
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: "itemCount",
    header: "Items",
    cell: ({ row }) => row.original.itemCount,
  },
  {
    accessorKey: "totalValueUsd",
    header: "Value",
    cell: ({ row }) => formatCurrency(row.original.totalValueUsd),
  },
  {
    id: "handledBy",
    header: "Handled By",
    cell: ({ row }) => {
      const by = row.original.processedBy || row.original.shippedBy;
      return by ? (
        <span className="text-xs">{by}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    },
  },
  {
    id: "tracking",
    header: "Tracking",
    cell: ({ row }) =>
      row.original.trackingNumber ? (
        <span className="font-mono text-xs">
          {row.original.trackingNumber}
          {row.original.carrier ? ` · ${row.original.carrier}` : ""}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    accessorKey: "requestedAt",
    header: "Requested",
    cell: ({ row }) => formatRelative(row.original.requestedAt),
  },
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => (
      <WithdrawalRowActions
        withdrawalId={row.original.id}
        status={row.original.status}
        method={row.original.method}
      />
    ),
  },
];
