"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils/format";
import type { CodeListItem } from "@/lib/queries/creators";

export const columns: ColumnDef<CodeListItem>[] = [
  {
    accessorKey: "code",
    header: "Code",
    cell: ({ row }) => (
      <Link
        href={`/creators/codes/${row.original.code}`}
        className="font-mono text-sm font-medium hover:underline"
      >
        {row.original.code}
      </Link>
    ),
  },
  {
    accessorKey: "ownerUsername",
    header: "Owner",
    cell: ({ row }) => (
      <Link
        href={`/creators/${row.original.ownerUserId}`}
        className="hover:underline"
      >
        {row.original.ownerUsername ?? row.original.ownerUserId.slice(0, 8)}
      </Link>
    ),
  },
  {
    accessorKey: "isActive",
    header: "Status",
    cell: ({ row }) => (
      <Badge
        variant="outline"
        className={
          row.original.isActive
            ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
            : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
        }
      >
        {row.original.isActive ? "Active" : "Inactive"}
      </Badge>
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Created",
    cell: ({ row }) => formatDateTime(row.original.createdAt),
  },
];
