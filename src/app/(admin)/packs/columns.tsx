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
    cell: ({ row }) => {
      // DB stores actual_rtp as percentage (e.g. 85.85 for 85.85%).
      // If > 2 it's already percentage; if <= 2 it's decimal (0.8585).
      const v = row.original.actualRtp;
      const pct = v > 2 ? v : v * 100;
      return `${pct.toFixed(2)}%`;
    },
  },
  {
    accessorKey: "actualHouseEdge",
    header: "House Edge %",
    cell: ({ row }) => {
      const v = row.original.actualHouseEdge;
      const pct = v > 2 ? v : v * 100;
      return `${pct.toFixed(2)}%`;
    },
  },
  {
    accessorKey: "active",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant="outline" className={row.original.active
        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
        : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
      }>
        {row.original.active ? "Active" : "Inactive"}
      </Badge>
    ),
  },
];
