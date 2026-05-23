"use client";

import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Swords } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { columns } from "./columns";
import type { BattleListItem } from "@/lib/queries/battles";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { InlineCancelBattleButton } from "./inline-cancel-button";

const BATTLE_STATUS_COLORS: Record<string, string> = {
  waiting:
    "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  in_progress:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  animating:
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  completed:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  cancelled:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

function BattleMobileCard({ battle }: { battle: BattleListItem }) {
  const router = useRouter();
  // House-edge negative = house lost on this battle → rose.
  const heg = battle.houseEdge;
  return (
    <div className="flex items-center gap-2 border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => router.push(`/battles/${battle.id}`)}
        className="flex flex-1 items-center gap-3 px-3 py-3 text-left min-h-[56px] hover:bg-muted/40 active:bg-muted/60 transition-colors min-w-0"
      >
        <div className="flex size-9 items-center justify-center rounded-md bg-purple-500/10 shrink-0">
          <Swords className="size-4 text-purple-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className={
                "h-4 px-1 text-[9px] capitalize " +
                (BATTLE_STATUS_COLORS[battle.status] ?? "")
              }
            >
              {battle.status.replace(/_/g, " ")}
            </Badge>
            <span className="truncate text-xs text-muted-foreground">
              {battle.username ?? battle.userId.slice(0, 8)}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <Badge variant="outline" className="h-3.5 px-1 text-[9px] uppercase">
              {battle.mode}
            </Badge>
            <span>
              {battle.teams}×{battle.playersPerTeam}
            </span>
            <span>•</span>
            <span>{formatRelative(battle.createdAt)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-medium tabular-nums">
            {formatCurrency(battle.betAmount)}
          </div>
          {heg != null && (
            <div
              className={
                "text-[10px] tabular-nums " +
                (heg < 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground")
              }
            >
              {heg.toFixed(1)}% edge
            </div>
          )}
        </div>
      </button>
      {battle.status === "waiting" && (
        <div className="pr-2">
          <InlineCancelBattleButton battleId={battle.id} />
        </div>
      )}
    </div>
  );
}

export function BattlesDataTable({ data }: { data: BattleListItem[] }) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Swords}
              title="No battles found"
              description="No case battles match the current filters. Try a different status, mode, or time window."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((battle) => (
              <BattleMobileCard key={battle.id} battle={battle} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-0">
                  <EmptyState
                    icon={Swords}
                    title="No battles found"
                    description="No case battles match the current filters. Try a different status, mode, or time window."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
