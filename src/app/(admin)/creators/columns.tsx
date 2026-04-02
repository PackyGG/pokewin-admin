"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils/format";
import type { CreatorListItem } from "@/lib/queries/creators";
import { InlineLevelSelect } from "./inline-level-select";
import { InlinePayoutButton } from "./inline-payout-button";
import { InlineLimits } from "./inline-limits";

export const columns: ColumnDef<CreatorListItem>[] = [
  {
    accessorKey: "username",
    header: "Username",
    cell: ({ row }) => (
      <Link
        href={`/creators/${row.original.userId}`}
        className="font-medium hover:underline"
      >
        {row.original.username ?? row.original.userId.slice(0, 8)}
      </Link>
    ),
  },
  {
    accessorKey: "code",
    header: "Primary Code",
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.code}</span>
    ),
  },
  {
    accessorKey: "level",
    header: "Level",
    cell: ({ row }) => (
      <InlineLevelSelect userId={row.original.userId} currentLevel={row.original.level} />
    ),
  },
  {
    accessorKey: "totalReferred",
    header: "Referred",
  },
  {
    accessorKey: "totalEarnedUsd",
    header: "Earned",
    cell: ({ row }) => formatCurrency(row.original.totalEarnedUsd),
  },
  {
    accessorKey: "availableUsd",
    header: "Available",
    cell: ({ row }) => formatCurrency(row.original.availableUsd),
  },
  {
    accessorKey: "totalPaidOutUsd",
    header: "Paid Out",
    cell: ({ row }) => formatCurrency(row.original.totalPaidOutUsd),
  },
  {
    id: "limits",
    header: "Limits",
    size: 300,
    cell: ({ row }) => (
      <InlineLimits userId={row.original.userId} limits={row.original.limits} />
    ),
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => (
      <InlinePayoutButton userId={row.original.userId} availableUsd={row.original.availableUsd} />
    ),
  },
];
