"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils/format";
import type { CreatorListItem } from "@/lib/queries/creators";
import { InlineCodes } from "./inline-codes";
import { InlineLevelSelect } from "./inline-level-select";
import { InlinePayoutButton } from "./inline-payout-button";
import { InlineLimits } from "./inline-limits";

export const columns: ColumnDef<CreatorListItem>[] = [
  {
    accessorKey: "username",
    header: "Username",
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        {/* Live "Active" dot — only renders for creators with at
            least one active deal. Pulses softly via motion-safe so
            it draws the eye without being noisy under reduce-motion. */}
        {row.original.hasActiveDeal && (
          <span
            className="relative flex size-2 shrink-0"
            aria-label="Active deal"
            title="Has an active deal"
          >
            <span className="absolute inline-flex size-full rounded-full bg-emerald-500/70 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
        )}
        <Link
          href={`/creators/${row.original.userId}`}
          className="font-medium hover:underline"
        >
          {row.original.username ?? row.original.userId.slice(0, 8)}
        </Link>
      </div>
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
    accessorKey: "totalSignups",
    header: "Signups",
    cell: ({ row }) => row.original.totalSignups,
  },
  {
    accessorKey: "totalReferred",
    header: "Depositors",
  },
  {
    accessorKey: "totalEarnedUsd",
    header: "Earned",
    cell: ({ row }) => formatCurrency(row.original.totalEarnedUsd),
  },
  {
    // Affiliate codes the creator owns. Trigger shows "{primary} +{N}"
    // when there are extras, the popover lets the admin add or remove
    // individual codes inline. Sits next to Earned per user direction
    // so the column reads as part of the creator-economics cluster.
    id: "codes",
    header: "Codes",
    cell: ({ row }) => (
      <InlineCodes
        userId={row.original.userId}
        codes={row.original.codes}
      />
    ),
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
