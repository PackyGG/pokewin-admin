"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import type { WithdrawalListItem } from "@/lib/queries/withdrawals";
import { WithdrawalRequestActions, ActiveShipmentActions } from "./row-actions";

const idColumn: ColumnDef<WithdrawalListItem, unknown> = {
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
};

const userColumn: ColumnDef<WithdrawalListItem, unknown> = {
  accessorKey: "username",
  header: "User",
  cell: ({ row }) => (
    <Link href={`/users/${row.original.userId}`} className="hover:underline">
      {row.original.username}
    </Link>
  ),
};

const methodColumn: ColumnDef<WithdrawalListItem, unknown> = {
  accessorKey: "method",
  header: "Method",
  cell: ({ row }) => (
    <Badge variant="outline">{row.original.method}</Badge>
  ),
};

const itemsColumn: ColumnDef<WithdrawalListItem, unknown> = {
  accessorKey: "itemCount",
  header: "Items",
  cell: ({ row }) => row.original.itemCount,
};

const valueColumn: ColumnDef<WithdrawalListItem, unknown> = {
  accessorKey: "totalValueUsd",
  header: "Value",
  cell: ({ row }) => formatCurrency(row.original.totalValueUsd),
};

const requestedColumn: ColumnDef<WithdrawalListItem, unknown> = {
  accessorKey: "requestedAt",
  header: "Requested",
  cell: ({ row }) => formatRelative(row.original.requestedAt),
};

// --- Tab-specific column arrays ---

/** Withdrawal Requests — pending, all methods */
export const requestColumns: ColumnDef<WithdrawalListItem, unknown>[] = [
  idColumn,
  userColumn,
  methodColumn,
  itemsColumn,
  valueColumn,
  requestedColumn,
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => <WithdrawalRequestActions withdrawalId={row.original.id} />,
  },
];

/** Shipping Requests — pending, physical only */
export const shippingRequestColumns: ColumnDef<WithdrawalListItem, unknown>[] = [
  idColumn,
  userColumn,
  itemsColumn,
  valueColumn,
  {
    id: "address",
    header: "Address",
    cell: ({ row }) => {
      const snapshot = row.original.shippingAddressSnapshot as Record<string, string> | null;
      if (!snapshot) return <span className="text-muted-foreground">—</span>;
      const parts = [snapshot.city, snapshot.state, snapshot.country].filter(Boolean);
      return (
        <span className="text-xs" title={JSON.stringify(snapshot, null, 2)}>
          {parts.join(", ") || "Address on file"}
        </span>
      );
    },
  },
  requestedColumn,
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => <WithdrawalRequestActions withdrawalId={row.original.id} />,
  },
];

/** Finished — completed/cancelled/failed */
export const finishedColumns: ColumnDef<WithdrawalListItem, unknown>[] = [
  idColumn,
  userColumn,
  methodColumn,
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant="outline" className={STATUS_COLORS[row.original.status]}>
        {row.original.status}
      </Badge>
    ),
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
    id: "reason",
    header: "Reason",
    cell: ({ row }) =>
      row.original.failureReason ? (
        <span className="max-w-[200px] truncate text-xs" title={row.original.failureReason}>
          {row.original.failureReason}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  valueColumn,
  requestedColumn,
];

/** Active Shipments — processing/shipped, physical only */
export const activeShipmentColumns: ColumnDef<WithdrawalListItem, unknown>[] = [
  idColumn,
  userColumn,
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant="outline" className={STATUS_COLORS[row.original.status]}>
        {row.original.status}
      </Badge>
    ),
  },
  itemsColumn,
  valueColumn,
  {
    id: "tracking",
    header: "Tracking",
    cell: ({ row }) =>
      row.original.trackingNumber ? (
        <span className="font-mono text-xs">{row.original.trackingNumber}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: "carrier",
    header: "Carrier",
    cell: ({ row }) =>
      row.original.carrier ?? <span className="text-muted-foreground">—</span>,
  },
  {
    id: "approvedBy",
    header: "Approved By",
    cell: ({ row }) =>
      row.original.processedBy ? (
        <span className="text-xs">{row.original.processedBy}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => (
      <ActiveShipmentActions
        withdrawalId={row.original.id}
        status={row.original.status}
      />
    ),
  },
];
