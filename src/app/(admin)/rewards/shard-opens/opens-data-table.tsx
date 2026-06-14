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
 * Feed of individual shard-pack opens.
 *
 * TWO UNITS, NEVER MIXED:
 *  • SHARDS — the secondary, wager-earned currency the open is bet/won in
 *    (spent / won / net house columns). Rendered as plain shard counts.
 *  • USD — the real DOLLAR value of the CARD(s) the open rolled into the
 *    user's inventory ("Card value" column). This is real money the house
 *    paid out, rendered with the currency formatter, NEVER summed with shards.
 *
 * House-POV coloring (same as the coin/shard economy panels): shards a user
 * SPENDS into an open (house takes in) → emerald; shards a user WINS (house
 * liability) → rose; net house (spent − won) → emerald when the house is up,
 * rose when down. The USD card value the user pulled is real money OUT of the
 * house → rose. Quick test: a user celebrating their win/card → rose.
 */

/** Round + format a shard amount; guards NaN/Infinity to "—". */
function fmtShards(n: number): string {
  if (!Number.isFinite(n)) return "—";
  // Shard amounts are small decimals (e.g. 0.15, 1.28) — keep 2dp so the
  // open cost/win reads precisely, but drop trailing for whole numbers.
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

/** Short, readable pack label for an open (handles multi-pack opens). */
function packLabel(row: ShardPackOpenRow): string {
  if (row.packNames.length === 0) {
    return row.packs > 0 ? `${row.packs} pack${row.packs === 1 ? "" : "s"}` : "—";
  }
  if (row.packNames.length === 1) return row.packNames[0];
  return `${row.packNames[0]} +${row.packNames.length - 1}`;
}

function ShardOpenMobileCard({ row }: { row: ShardPackOpenRow }) {
  const houseUp = row.netHouse >= 0;
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
      secondary={<span className="truncate">{packLabel(row)}</span>}
      trailing={
        <div className="flex flex-col items-end">
          {/* Spent → emerald (house took in), won → rose (house paid out). */}
          <span className="text-sm font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
            +{fmtShards(row.spent)}
          </span>
          {row.won > 0 ? (
            <span className="text-xs tabular-nums text-rose-600 dark:text-rose-400">
              -{fmtShards(row.won)}
            </span>
          ) : (
            <span className="text-xs tabular-nums text-muted-foreground">—</span>
          )}
        </div>
      }
      footer={
        <span className="flex flex-wrap items-center gap-2">
          <span>{formatRelative(row.createdAt)}</span>
          <span className="text-muted-foreground">·</span>
          <span
            className={
              "tabular-nums " +
              (houseUp
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400")
            }
          >
            Net {houseUp ? "+" : "-"}
            {fmtShards(Math.abs(row.netHouse))} shards
          </span>
          {/* USD card value pulled (real money out) → rose. Hidden when no
              inventory card is linked to the open yet. Distinct unit (USD). */}
          {row.cardValueUsd > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(row.cardValueUsd)} card
              </span>
            </>
          )}
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
              {/* Spent = shards wagered into the open (house in, emerald).
                  Won = shards returned to the user (house out, rose). Net
                  house = spent − won. All in SHARDS, never USD. */}
              <TableHead className="text-right">Shards spent</TableHead>
              <TableHead className="text-right">Shards won</TableHead>
              <TableHead className="text-right">Net house</TableHead>
              {/* USD value of the card(s) the open rolled into inventory —
                  REAL money the house paid out (house cost, rose). Distinct
                  unit from the shard columns. */}
              <TableHead className="text-right">Card value ($)</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="p-0">
                  <EmptyState
                    icon={Gem}
                    title="No shard-pack opens found"
                    description="No shard packs were opened in this window. Try a wider timeframe."
                    compact
                  />
                </TableCell>
              </TableRow>
            ) : (
              data.map((row) => {
                const houseUp = row.netHouse >= 0;
                return (
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
                      <span className="flex flex-col">
                        <span className="truncate">{packLabel(row)}</span>
                        {row.packs > 1 && (
                          <span className="text-[11px] text-muted-foreground">
                            {row.packs} packs this open
                          </span>
                        )}
                      </span>
                    </TableCell>
                    {/* Spent → emerald (house took it in). */}
                    <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      +{fmtShards(row.spent)}
                    </TableCell>
                    {/* Won → rose (house paid out). "—" on a zero-win open so
                        the column doesn't read 0 on every loss. */}
                    <TableCell className="text-right tabular-nums">
                      {row.won > 0 ? (
                        <span className="text-rose-600 dark:text-rose-400">
                          -{fmtShards(row.won)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell
                      className={
                        "text-right tabular-nums " +
                        (houseUp
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400")
                      }
                    >
                      {houseUp ? "+" : "-"}
                      {fmtShards(Math.abs(row.netHouse))}
                    </TableCell>
                    {/* USD card value pulled → rose (real money out of the
                        house). "—" when no inventory card is linked to the
                        open yet, so the column doesn't read $0.00 on every
                        un-linked open. */}
                    <TableCell className="text-right tabular-nums">
                      {row.cardValueUsd > 0 ? (
                        <span
                          className="text-rose-600 dark:text-rose-400"
                          title={
                            row.cardCount > 0
                              ? `${formatNumber(row.cardCount)} card${row.cardCount === 1 ? "" : "s"} pulled — real money out`
                              : "Card value pulled — real money out"
                          }
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
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
