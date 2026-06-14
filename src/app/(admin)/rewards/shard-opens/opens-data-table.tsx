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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MobileCard } from "@/components/data-table/mobile-card-list";
import { EmptyState } from "@/components/empty-state";
import { Gem } from "lucide-react";
import {
  formatDateTime,
  formatRelative,
  formatNumber,
  formatCurrency,
} from "@/lib/utils/format";
import type { ShardPackOpenRow } from "@/lib/queries/shard-pack-opens";

/**
 * Feed of individual shard-pack opens (Common / Uncommon / Rare).
 *
 * TWO UNITS, NEVER MIXED:
 *  • SHARDS — the secondary, wager-earned currency the open COSTS (the pack's
 *    shard_cost). A shard pack returns a card, NOT shards — there is no shard
 *    payout. Rendered as a plain shard count, NEUTRAL (cyan) since shards are
 *    not money and must never be summed with dollars.
 *  • USD — the real DOLLAR value of the CARD the open rolled into the user's
 *    inventory ("Card value" column). This is real money the house paid out,
 *    rendered with the currency formatter → ROSE (house cost). Quick test: a
 *    user celebrating their card pull → rose.
 */

/** Round + format a shard amount; guards NaN/Infinity to "—". */
function fmtShards(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded)
    ? formatNumber(rounded)
    : rounded.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

function initialsFor(username: string | null, userId: string): string {
  const src = username ?? userId;
  return src.slice(0, 2).toUpperCase();
}

function ShardOpenMobileCard({ row }: { row: ShardPackOpenRow }) {
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
          <span className="truncate">{row.username ?? row.userId.slice(0, 8)}</span>
        </span>
      }
      secondary={
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate">{row.packName}</span>
          <span className="text-muted-foreground">·</span>
          {/* Shards spent → neutral cyan (the cost to open; not money). */}
          <span className="tabular-nums text-cyan-600 dark:text-cyan-400">
            {fmtShards(row.shardsSpent)} shards
          </span>
        </span>
      }
      trailing={
        <div className="flex flex-col items-end">
          {/* Card value pulled → rose (real money out of the house). */}
          {row.cardValueUsd > 0 ? (
            <span className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(row.cardValueUsd)}
            </span>
          ) : (
            <span className="text-sm tabular-nums text-muted-foreground">—</span>
          )}
          {row.cardName && (
            <span className="max-w-[120px] truncate text-[11px] text-muted-foreground">
              {row.cardName}
            </span>
          )}
        </div>
      }
      footer={
        <span className="flex flex-wrap items-center gap-2">
          <span>{formatRelative(row.createdAt)}</span>
        </span>
      }
    />
  );
}

export function ShardOpensDataTable({ data }: { data: ShardPackOpenRow[] }) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Gem}
              title="No shard-pack opens found"
              description="No shard packs were opened in this window. Try a wider timeframe."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((row) => (
              <ShardOpenMobileCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Pack</TableHead>
              {/* Shards spent = the pack's shard_cost (house in). Shards are a
                  secondary currency, not USD → neutral (cyan). */}
              <TableHead className="text-right">Shards spent</TableHead>
              <TableHead>Card pulled</TableHead>
              {/* USD value of the card the open rolled into inventory — REAL
                  money the house paid out (house cost, rose). Distinct unit
                  from the shard column. */}
              <TableHead className="text-right">Card value ($)</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={Gem}
                    title="No shard-pack opens found"
                    description="No shard packs were opened in this window. Try a wider timeframe."
                    compact
                  />
                </TableCell>
              </TableRow>
            ) : (
              data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/users/${row.userId}`}
                      className="flex items-center gap-2 hover:underline"
                    >
                      <Avatar className="size-6 shrink-0">
                        {row.image && <AvatarImage src={row.image} alt="" />}
                        <AvatarFallback className="text-[9px]">
                          {initialsFor(row.username, row.userId)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate">
                        {row.username ?? row.userId.slice(0, 8)}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="truncate">{row.packName}</span>
                  </TableCell>
                  {/* Shards spent → neutral cyan (cost to open, not money). */}
                  <TableCell className="text-right tabular-nums text-cyan-600 dark:text-cyan-400">
                    {fmtShards(row.shardsSpent)}
                  </TableCell>
                  <TableCell>
                    {row.cardName ? (
                      <span className="truncate">{row.cardName}</span>
                    ) : (
                      <span
                        className="text-muted-foreground"
                        title="No inventory card linked to this open yet"
                      >
                        —
                      </span>
                    )}
                  </TableCell>
                  {/* Card value pulled → rose (real money out of the house).
                      "—" when no inventory card is linked to the open yet. */}
                  <TableCell className="text-right tabular-nums">
                    {row.cardValueUsd > 0 ? (
                      <span
                        className="text-rose-600 dark:text-rose-400"
                        title="Card value pulled — real money out"
                      >
                        {formatCurrency(row.cardValueUsd)}
                      </span>
                    ) : (
                      <span
                        className="text-muted-foreground"
                        title="No inventory card linked to this open yet"
                      >
                        —
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(row.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
