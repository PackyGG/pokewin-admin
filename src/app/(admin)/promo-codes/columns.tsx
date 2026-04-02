"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import type { PromoCodeListItem } from "@/lib/queries/promo-codes";

export const columns: ColumnDef<PromoCodeListItem>[] = [
  {
    accessorKey: "code",
    header: "Code",
    cell: ({ row }) => (
      <Link
        href={`/promo-codes/${row.original.id}`}
        className="font-mono text-xs hover:underline"
      >
        {row.original.code ?? row.original.codeHash.slice(0, 16) + "..."}
      </Link>
    ),
  },
  {
    accessorKey: "value",
    header: "Value",
    cell: ({ row }) => formatCurrency(row.original.value),
  },
  {
    accessorKey: "minimumLevel",
    header: "Min Level",
  },
  {
    accessorKey: "maxUses",
    header: "Max Uses",
  },
  {
    accessorKey: "redemptionCount",
    header: "Redemptions",
    cell: ({ row }) => (
      <span>
        {row.original.redemptionCount} / {row.original.maxUses}
      </span>
    ),
  },
  {
    accessorKey: "expiresAt",
    header: "Expires",
    cell: ({ row }) => {
      if (!row.original.expiresAt) return "Never";
      const expired = new Date(row.original.expiresAt) < new Date();
      return (
        <span className={expired ? "text-red-400" : ""}>
          {formatDate(row.original.expiresAt)}
        </span>
      );
    },
  },
  {
    accessorKey: "createdAt",
    header: "Created",
    cell: ({ row }) => formatDate(row.original.createdAt),
  },
];
