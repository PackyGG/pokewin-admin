"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
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

// First-mount fade gate. The list page streams the table behind a keyed
// <Suspense>, so switching tab / mode / sort / period remounts this client
// component and would re-run the FadeIn every time — a distracting re-fade
// on an otherwise-instant (cached) filter switch. This module-scoped flag
// lets the table fade once when it first appears in the client session and
// skip the fade on subsequent filter switches. A hard reload re-initialises
// the module, so genuine fresh loads still fade.
let hasFadedOnce = false;

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
  const router = useRouter();
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  // Fade in only the first time the table appears in this client session.
  // On cached filter switches (tab / mode / sort / period) the keyed
  // <Suspense> remounts this component; without the gate the FadeIn would
  // replay on every switch. Consulting + flipping the module flag inside a
  // lazy useState initializer keeps it running exactly once per mount (no
  // impure mutation during render), so the first mount fades and every
  // later mount skips it. `motion-safe:` still yields the final state
  // instantly for reduced-motion users; a hard reload re-fades.
  const [shouldFade] = useState(() => {
    if (hasFadedOnce) return false;
    hasFadedOnce = true;
    return true;
  });

  return (
    <div
      className={cn(
        shouldFade &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300",
      )}
    >
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
                // Full-row click affordance — parity with the mobile card,
                // which already routes on tap. Clicking anywhere on the row
                // opens the battle detail; the ID / Creator cells keep their
                // own <Link> (native nav still works), and the inline cancel
                // action stops propagation so cancelling never navigates.
                <TableRow
                  key={row.id}
                  onClick={() => router.push(`/battles/${row.original.id}`)}
                  className="cursor-pointer"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      // The actions column hosts the inline cancel button (an
                      // AlertDialog). Stop row-click navigation there so
                      // opening/confirming the dialog doesn't also push the
                      // detail route out from under it.
                      onClick={
                        cell.column.id === "actions"
                          ? (e) => e.stopPropagation()
                          : undefined
                      }
                    >
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
    </div>
  );
}
