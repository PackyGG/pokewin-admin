"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { BorrowBadge } from "@/components/borrow-badge";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import type { BattleListItem } from "@/lib/queries/battles";
import { InlineCancelBattleButton } from "./inline-cancel-button";

const BATTLE_STATUS_COLORS: Record<string, string> = {
  waiting: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  animating: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

/**
 * Compact representation of the winner's payout multiplier. Keeps
 * the badge readable across the full range we expect to see:
 *   • < 10×  → one decimal (e.g. 2.5×, 8.3×)
 *   • < 1000× → integer (e.g. 12×, 100×)
 *   • ≥ 1000× → k-suffixed integer (e.g. 1.2k×) so the column
 *     doesn't blow up when a $1 bet hits a $5000 card
 */
function formatHitMultiplier(m: number): string {
  if (m < 10) return `${m.toFixed(1)}×`;
  if (m < 1000) return `${Math.round(m)}×`;
  return `${(m / 1000).toFixed(1)}k×`;
}

export const columns: ColumnDef<BattleListItem>[] = [
  {
    accessorKey: "id",
    header: "ID",
    cell: ({ row }) => (
      <Link
        href={`/battles/${row.original.id}`}
        className="font-mono text-xs hover:underline"
      >
        {row.original.id.slice(0, 8)}...
      </Link>
    ),
  },
  {
    accessorKey: "username",
    header: "Creator",
    cell: ({ row }) => (
      <Link href={`/users/${row.original.userId}`} className="hover:underline">
        {row.original.username ?? row.original.userId.slice(0, 8)}
      </Link>
    ),
  },
  {
    accessorKey: "mode",
    header: "Mode",
    cell: ({ row }) => <Badge variant="outline">{row.original.mode}</Badge>,
  },
  {
    accessorKey: "teams",
    header: "Teams",
    cell: ({ row }) => `${row.original.teams} x ${row.original.playersPerTeam}`,
  },
  {
    accessorKey: "betAmount",
    header: "Bet",
    // Bet column doubles as the borrow surface — admins scanning the
    // table want to know "how much was bet AND was it borrowed" in
    // the same glance. Stacking the bet amount over the BorrowBadge
    // keeps the column compact and avoids adding a separate column.
    cell: ({ row }) => (
      <div className="flex flex-col items-start gap-0.5">
        <span className="tabular-nums">
          {formatCurrency(row.original.betAmount)}
        </span>
        <BorrowBadge
          percent={row.original.borrowPercentage}
          amountUsd={row.original.borrowedAmountUsd}
          size="sm"
        />
      </div>
    ),
  },
  {
    accessorKey: "totalPotUsd",
    header: "Hit",
    // "Hit" = total card value paid out across the whole battle (sum
    // across every team, regardless of who won). This is the size of
    // the actual hit — what someone walked away with. House loss → rose.
    // The smaller "Nx" badge under the amount is the winner's payout
    // multiplier (totalCardValue / bet_amount). The "Biggest Hit" sort
    // ranks by this multiplier, not the absolute pot — a $100 → $10k
    // hit (100×) beats a $5k → $40k hit (8×) even though the absolute
    // pot is smaller.
    cell: ({ row }) => {
      const p = row.original.totalPotUsd;
      const m = row.original.hitMultiplier;
      const locked = row.original.outcomeLocked;
      if (p == null) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-col items-start gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-rose-600 dark:text-rose-400">
              {formatCurrency(p)}
            </span>
            {/* Pre-resolved pending battle: outcome is locked in the DB
                but the on-site animation hasn't settled yet. Neutral
                marker (status, not money) so admins can tell it apart
                from a finalized Hit. */}
            {locked && (
              <Badge
                variant="outline"
                className="px-1 py-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                settling
              </Badge>
            )}
          </div>
          {m != null && m > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {formatHitMultiplier(m)}
            </span>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: "houseEdge",
    header: "House Edge",
    // House edge negative = house lost money on this battle → rose.
    cell: ({ row }) => {
      const he = row.original.houseEdge;
      if (he == null) return <span className="text-muted-foreground">—</span>;
      return (
        <span className={he < 0 ? "text-rose-600 dark:text-rose-400" : ""}>
          {he.toFixed(2)}%
        </span>
      );
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant="outline" className={BATTLE_STATUS_COLORS[row.original.status] ?? ""}>
        {row.original.status.replace(/_/g, " ")}
      </Badge>
    ),
  },
  {
    accessorKey: "regionCode",
    header: "Region",
    cell: ({ row }) => <Badge variant="outline">{row.original.regionCode}</Badge>,
  },
  {
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) => formatDateTime(row.original.createdAt),
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) =>
      row.original.status === "waiting" ? (
        <InlineCancelBattleButton battleId={row.original.id} />
      ) : null,
  },
];
