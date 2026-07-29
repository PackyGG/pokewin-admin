"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import type { WithdrawalListItem } from "@/lib/queries/withdrawals";

// Initials fallback for users without a profile picture — mirrors the
// pattern used in src/app/(admin)/transactions/deposits/columns.tsx.
function initialsFor(username: string | null, userId: string): string {
  const src = username ?? userId;
  return src.slice(0, 2).toUpperCase();
}

/**
 * Unified column set for the Withdrawals tab on /transactions/deposits.
 *
 * The Handled By / Tracking / Actions columns were dropped per admin
 * request — they bloated the row without adding signal at the list
 * level. Handled By + Tracking are still surfaced on the detail page;
 * Actions are reachable by clicking through to the detail page.
 *
 * The Crypto column replaced them: shows the crypto asset code (e.g.
 * BTC, ETH_TEST5) on crypto-method rows so the chain is visible at a
 * glance without opening the detail page. Physical-method rows render
 * "—" so the column stays clean.
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
    id: "fiatFunding",
    header: "Funding",
    cell: ({ row }) =>
      row.original.hasFiatFunding ? (
        <Badge
          variant="outline"
          className="border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-400"
        >
          Fiat
        </Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    // Crypto asset code surfaced inline so the chain is visible at the
    // list level. Renders the raw asset token (BTC, ETH_TEST5, USDC,
    // …) as a compact chip; physical-method rows have a null asset and
    // render an em-dash so the column stays aligned.
    id: "cryptoAsset",
    header: "Crypto",
    cell: ({ row }) =>
      row.original.cryptoAsset ? (
        <Badge variant="outline" className="font-mono text-[10px]">
          {row.original.cryptoAsset}
        </Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
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
    // House-POV: a withdrawal value = money the user takes out of the
    // house → house loss → rose. Matches the mobile card + the detail
    // page's "Total Value" KPI so the figure reads the same everywhere.
    cell: ({ row }) => (
      <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
        {formatCurrency(row.original.totalValueUsd)}
      </span>
    ),
  },
  {
    accessorKey: "requestedAt",
    header: "Requested",
    cell: ({ row }) => formatRelative(row.original.requestedAt),
  },
];
