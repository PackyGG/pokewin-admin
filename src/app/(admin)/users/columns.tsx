"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ROLE_COLORS, USER_STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils/format";

export type UserRow = {
  id: string;
  username: string | null;
  email: string | null;
  role: string;
  status: string;
  availableBalance: number;
  totalDeposited: number;
  createdAt: string;
};

export const columns: ColumnDef<UserRow>[] = [
  {
    accessorKey: "username",
    header: "Username",
    cell: ({ row }) => (
      <Link
        href={`/users/${row.original.id}`}
        className="font-medium hover:underline"
      >
        {row.original.username ?? row.original.email}
      </Link>
    ),
  },
  {
    accessorKey: "email",
    header: "Email",
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.email}</span>
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
      <Badge variant="outline" className={USER_STATUS_COLORS[row.original.status]}>
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: "availableBalance",
    header: "Balance",
    cell: ({ row }) => formatCurrency(row.original.availableBalance),
  },
  {
    accessorKey: "totalDeposited",
    header: "Total Deposited",
    cell: ({ row }) => formatCurrency(row.original.totalDeposited),
  },
  {
    accessorKey: "createdAt",
    header: "Registered",
    cell: ({ row }) => formatDate(row.original.createdAt),
  },
];
