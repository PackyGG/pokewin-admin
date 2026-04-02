"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { PackListItem } from "@/lib/queries/packs";

export const columns: ColumnDef<PackListItem>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <Link
        href={`/packs/${row.original.id}`}
        className="font-medium hover:underline"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: "slug",
    header: "Slug",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.slug}
      </span>
    ),
  },
  {
    accessorKey: "priceUsd",
    header: "Price",
    cell: ({ row }) => formatCurrency(row.original.priceUsd),
  },
  {
    accessorKey: "cardsPerOpen",
    header: "Cards/Open",
  },
  {
    accessorKey: "totalOpenings",
    header: "Openings",
    cell: ({ row }) => formatNumber(row.original.totalOpenings),
  },
  {
    accessorKey: "totalRevenue",
    header: "Revenue",
    cell: ({ row }) => formatCurrency(row.original.totalRevenue),
  },
  {
    accessorKey: "actualRtp",
    header: "RTP %",
    cell: ({ row }) => `${(row.original.actualRtp * 100).toFixed(2)}%`,
  },
  {
    accessorKey: "actualHouseEdge",
    header: "House Edge %",
    cell: ({ row }) => `${(row.original.actualHouseEdge * 100).toFixed(2)}%`,
  },
  {
    accessorKey: "active",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant="outline" className={row.original.active
        ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
        : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
      }>
        {row.original.active ? "Active" : "Inactive"}
      </Badge>
    ),
  },
];
