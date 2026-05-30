"use client";

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MobileCard } from "@/components/data-table/mobile-card-list";
import { EmptyState } from "@/components/empty-state";
import { ArrowUpCircle } from "lucide-react";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import type { UpgraderTransactionRow } from "@/lib/queries/upgrader-transactions";

/**
 * Compact multiplier formatter — matches the badge style used on the
 * /transactions/packs Items Won cell:
 *   • < 10×   → one decimal (e.g. 2.5×, 8.3×)
 *   • < 1000× → integer (e.g. 12×, 100×)
 *   • ≥ 1000× → k-suffixed (e.g. 1.2k×)
 */
function formatMultiplier(m: number): string {
  if (m < 10) return `${m.toFixed(1)}×`;
  if (m < 1000) return `${Math.round(m)}×`;
  return `${(m / 1000).toFixed(1)}k×`;
}

function initialsFor(username: string | null, userId: string): string {
  const src = username ?? userId;
  return src.slice(0, 2).toUpperCase();
}

/**
 * House-POV badge tone for the outcome chip:
 *   • win  → rose (user won → money left the house)
 *   • loss → emerald (user lost → house kept the wager)
 * Mirrors the global house-POV rule used across /transactions and
 * /battles.
 */
const OUTCOME_COLORS = {
  win: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  loss: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
} as const;

function UpgraderMobileCard({ row }: { row: UpgraderTransactionRow }) {
  const houseGain = row.housePnl >= 0;
  return (
    <MobileCard
      leading={
        <Avatar className="size-9 shrink-0">
          {row.image && <AvatarImage src={row.image} alt="" />}
          <AvatarFallback className="text-[10px]">
            {initialsFor(row.username, row.userId)}
          </AvatarFallback>
        </Avatar>
      }
      primary={
        <span className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={"h-4 px-1.5 text-[9px] capitalize " + OUTCOME_COLORS[row.outcome]}
          >
            {row.outcome}
          </Badge>
          <span className="truncate text-xs text-muted-foreground">
            {row.username ?? row.userId.slice(0, 8)}
          </span>
        </span>
      }
      secondary={
        <span className="font-mono text-[10px]">{row.id.slice(0, 12)}…</span>
      }
      trailing={
        <div className="flex flex-col items-end">
          {/* House-POV bet → green (we took it in), payout → rose (we
              paid out). Stack vertically so the row reads "bet / won"
              without horizontal crowding on phones. */}
          <span className="text-sm font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
            +{formatCurrency(row.betAmount)}
          </span>
          {row.wonAmount > 0 && (
            <span className="text-xs tabular-nums text-rose-600 dark:text-rose-400">
              -{formatCurrency(row.wonAmount)}
              {row.multiplier != null && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {formatMultiplier(row.multiplier)}
                </span>
              )}
            </span>
          )}
        </div>
      }
      footer={
        <span className="flex items-center gap-2">
          <span>{formatRelative(row.createdAt)}</span>
          <span className="text-muted-foreground">·</span>
          <span
            className={
              "tabular-nums " +
              (houseGain
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400")
            }
          >
            House {houseGain ? "+" : "-"}
            {formatCurrency(Math.abs(row.housePnl))}
          </span>
        </span>
      }
    />
  );
}

export function UpgraderTransactionsDataTable({
  data,
}: {
  data: UpgraderTransactionRow[];
}) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={ArrowUpCircle}
              title="No upgrader games found"
              description="No upgrader plays match the current filters. Try a different outcome or clear the search."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((row) => (
              <UpgraderMobileCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Outcome</TableHead>
              {/* Bet → wagered (house gain, emerald). Won → paid out to
                  user (house loss, rose). House P&L is the net for the
                  row. Mirrors /transactions house-POV convention. */}
              <TableHead>Bet</TableHead>
              <TableHead>Won</TableHead>
              <TableHead>Multiplier</TableHead>
              <TableHead>House P&L</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-0">
                  <EmptyState
                    icon={ArrowUpCircle}
                    title="No upgrader games found"
                    description="No upgrader plays match the current filters. Try a different outcome or clear the search."
                    compact
                  />
                </TableCell>
              </TableRow>
            ) : (
              data.map((row) => {
                const houseGain = row.housePnl >= 0;
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <span className="font-mono text-xs">
                        {row.id.slice(0, 8)}...
                      </span>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/users/${row.userId}`}
                        className="hover:underline"
                      >
                        {row.username ?? row.userId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={"capitalize " + OUTCOME_COLORS[row.outcome]}
                      >
                        {row.outcome}
                      </Badge>
                    </TableCell>
                    {/* Bet = wagered, money flowed into house → emerald. */}
                    <TableCell className="text-emerald-600 dark:text-emerald-400 tabular-nums">
                      +{formatCurrency(row.betAmount)}
                    </TableCell>
                    {/* Won = money flowed out to user → rose. Show "—"
                        for losses so the column doesn't read "$0.00" on
                        every losing row. */}
                    <TableCell className="tabular-nums">
                      {row.wonAmount > 0 ? (
                        <span className="text-rose-600 dark:text-rose-400">
                          -{formatCurrency(row.wonAmount)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.multiplier != null ? (
                        formatMultiplier(row.multiplier)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell
                      className={
                        "tabular-nums " +
                        (houseGain
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400")
                      }
                    >
                      {houseGain ? "+" : "-"}
                      {formatCurrency(Math.abs(row.housePnl))}
                    </TableCell>
                    <TableCell>{formatDateTime(row.createdAt)}</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
