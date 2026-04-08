"use client";

import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { ROLE_COLORS, USER_STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export type UserRow = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  status: string;
  country: string | null;
  countryCode: string | null;
  availableBalance: number;
  inventoryValue: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalWagered: number;
  pnl: number;
  createdAt: string;
};

function PnlCell({ value }: { value: number }) {
  // User-perspective P&L:
  //   positive = user is winning  -> bad for us  -> RED
  //   negative = user is losing   -> good for us -> GREEN
  const isUserProfit = value > 0;
  const isUserLoss = value < 0;
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        isUserProfit && "text-rose-400",
        isUserLoss && "text-emerald-400",
      )}
    >
      {value >= 0 ? "+" : ""}
      {formatCurrency(value)}
    </span>
  );
}

function initialsFor(name: string | null, email: string | null): string {
  const src = name ?? email ?? "?";
  return src.slice(0, 2).toUpperCase();
}

export const columns: ColumnDef<UserRow>[] = [
  {
    accessorKey: "username",
    header: () => <DataTableColumnHeader title="User" sortKey="username" />,
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        <Avatar className="size-8 shrink-0">
          {row.original.image && <AvatarImage src={row.original.image} alt="" />}
          <AvatarFallback className="text-xs">
            {initialsFor(row.original.username, row.original.email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate font-medium">
            {row.original.username ?? row.original.email ?? "—"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {row.original.email}
          </div>
        </div>
      </div>
    ),
  },
  {
    accessorKey: "country",
    header: "Country",
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.country ??
          (row.original.countryCode ? row.original.countryCode : "—")}
      </span>
    ),
  },
  {
    accessorKey: "role",
    header: "Role",
    cell: ({ row }) => (
      <Badge variant="outline" className={ROLE_COLORS[row.original.role]}>
        {row.original.role}
      </Badge>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge
        variant="outline"
        className={USER_STATUS_COLORS[row.original.status]}
      >
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: "availableBalance",
    header: () => <DataTableColumnHeader title="Balance" sortKey="balance" />,
    cell: ({ row }) => (
      <span className="font-medium tabular-nums">
        {formatCurrency(row.original.availableBalance)}
      </span>
    ),
  },
  {
    accessorKey: "inventoryValue",
    header: "Inventory",
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatCurrency(row.original.inventoryValue)}
      </span>
    ),
  },
  {
    accessorKey: "totalWagered",
    header: () => <DataTableColumnHeader title="Wagered" sortKey="totalWagered" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatCurrency(row.original.totalWagered)}
      </span>
    ),
  },
  {
    accessorKey: "totalDeposited",
    header: () => (
      <DataTableColumnHeader title="Deposited" sortKey="totalDeposited" />
    ),
    cell: ({ row }) => (
      <span className="tabular-nums">
        {formatCurrency(row.original.totalDeposited)}
      </span>
    ),
  },
  {
    accessorKey: "totalWithdrawn",
    header: () => (
      <DataTableColumnHeader title="Withdrawn" sortKey="totalWithdrawn" />
    ),
    cell: ({ row }) => (
      <span className="tabular-nums">
        {formatCurrency(row.original.totalWithdrawn)}
      </span>
    ),
  },
  {
    accessorKey: "pnl",
    header: () => <DataTableColumnHeader title="P&L" sortKey="pnl" />,
    cell: ({ row }) => <PnlCell value={row.original.pnl} />,
  },
  {
    accessorKey: "createdAt",
    header: () => (
      <DataTableColumnHeader title="Registered" sortKey="created_at" />
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatDate(row.original.createdAt)}
      </span>
    ),
  },
];
