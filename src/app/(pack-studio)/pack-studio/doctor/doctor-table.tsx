"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { SlidersHorizontal, Stethoscope } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/empty-state";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { PackRiskRow } from "../_queries/doctor";
import { BulkRetuneButton } from "./bulk-retune-button";

/**
 * Pack Doctor scored grid (read-only). Renders the persisted risk rows in a
 * `@tanstack/react-table` shell matching the admin data-table house style,
 * with querystring-driven sortable headers (reusing
 * `DataTableColumnHeader`, keyed on `sortBy`/`sortOrder`).
 *
 * House-POV coloring — these surfaces report risk to the HOUSE, so a metric
 * that favors the player reads as a warning:
 *   • edge below the pack's OWN target → rose  (house giving away margin)
 *   • edge at/above its own target     → emerald (healthy house margin)
 *   • win-rate higher than typical     → rose-leaning amber as it climbs
 *
 * The edge target is a PER-PACK curve (floor 10.99% + a risk premium up to
 * 11.50%), carried on each row as `targetEdge`, so "below target" is judged
 * against the pack's own curve — not a flat 10.99%.
 * Everything else stays neutral tabular-nums; the per-pack compliance flags
 * render as warning badges.
 *
 * Pure presentation: sorting + filtering happen server-side (the page maps the
 * querystring to `getPackRiskRows` filters), so this component just paints the
 * already-ordered `rows`.
 */

/** Tier badge tint — escalates from cool (low vol) to rose (T5, highest vol). */
const TIER_COLORS: Record<string, string> = {
  T1: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  T2: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  T3: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  T4: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  T5: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

const FLAG_LABELS: { key: keyof NonNullable<PackRiskRow["compliance"]>; label: string }[] =
  [
    { key: "belowTargetEdge", label: "Below target" },
    { key: "overMaxWinCap", label: "Over cap" },
    { key: "zeroNearMiss", label: "Zero near-miss" },
    { key: "overTier", label: "T5" },
  ];

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function FlagBadges({ row }: { row: PackRiskRow }) {
  const flags = row.compliance;
  const active = flags
    ? FLAG_LABELS.filter((f) => flags[f.key])
    : [];
  if (active.length === 0) {
    return (
      <Badge
        variant="outline"
        className="h-5 px-1.5 text-[10px] border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      >
        OK
      </Badge>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {active.map((f) => (
        <Badge
          key={f.key}
          variant="outline"
          className="h-5 px-1.5 text-[10px] border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
        >
          {f.label}
        </Badge>
      ))}
    </div>
  );
}

/** Owner-only controls injected into the column set (selection + re-tune). */
type OwnerControls = {
  selected: Set<string>;
  toggle: (packId: string) => void;
  toggleAll: (packIds: string[], on: boolean) => void;
  allOnPage: string[];
  /** Deep-links into the Retune workspace (`/pack-studio/retune?pack=<id>`). */
  onRetune: (packId: string) => void;
};

function buildColumns(
  owner: OwnerControls | null,
): ColumnDef<PackRiskRow>[] {
  const cols: ColumnDef<PackRiskRow>[] = [];

  if (owner) {
    const allSelected =
      owner.allOnPage.length > 0 &&
      owner.allOnPage.every((id) => owner.selected.has(id));
    const someSelected =
      owner.allOnPage.some((id) => owner.selected.has(id)) && !allSelected;
    cols.push({
      id: "select",
      header: () => (
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onCheckedChange={(checked) => owner.toggleAll(owner.allOnPage, checked === true)}
          aria-label="Select all packs"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={owner.selected.has(row.original.packId)}
          onCheckedChange={() => owner.toggle(row.original.packId)}
          aria-label={`Select ${row.original.name}`}
        />
      ),
    });
  }

  cols.push(
    {
      accessorKey: "name",
      header: () => <DataTableColumnHeader title="Pack" sortKey="name" />,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="min-w-0">
            <div className="truncate font-medium">{r.name}</div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {formatCurrency(r.price)}
            </div>
          </div>
        );
      },
    },
    {
      accessorKey: "edge",
      header: () => <DataTableColumnHeader title="Edge" sortKey="edge" />,
      cell: ({ row }) => {
        const { edge, targetEdge } = row.original;
        // House-POV: edge below the pack's OWN curve target = house giving away
        // margin → rose; at/above its own target = healthy house margin →
        // emerald. The target is per-pack (floor 10.99% + risk premium).
        const healthy = edge >= targetEdge;
        return (
          <div className="leading-tight">
            <span
              className={cn(
                "tabular-nums font-medium",
                healthy
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {pct(edge)}
            </span>
            <span className="block text-[10px] text-muted-foreground tabular-nums">
              target {pct(targetEdge)}
            </span>
          </div>
        );
      },
    },
    {
      accessorKey: "winRate",
      header: () => <DataTableColumnHeader title="Win rate" sortKey="winRate" />,
      cell: ({ row }) => (
        <span className="tabular-nums">{pct(row.original.winRate)}</span>
      ),
    },
    {
      accessorKey: "nearMiss",
      header: () => (
        <DataTableColumnHeader title="Near-miss" sortKey="nearMiss" />
      ),
      cell: ({ row }) => {
        const nm = row.original.nearMiss;
        const zero = row.original.compliance?.zeroNearMiss === true;
        return (
          <span
            className={cn(
              "tabular-nums",
              zero && "text-rose-600 dark:text-rose-400",
            )}
          >
            {pct(nm)}
          </span>
        );
      },
    },
    {
      accessorKey: "maxWin",
      header: () => <DataTableColumnHeader title="Max win" sortKey="maxWin" />,
      cell: ({ row }) => {
        const over = row.original.compliance?.overMaxWinCap === true;
        return (
          <span
            className={cn(
              "tabular-nums",
              over && "text-rose-600 dark:text-rose-400",
            )}
          >
            {formatCurrency(row.original.maxWin)}
          </span>
        );
      },
    },
    {
      accessorKey: "maxMult",
      header: () => <DataTableColumnHeader title="Max mult" sortKey="maxMult" />,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatNumber(row.original.maxMult)}×
        </span>
      ),
    },
    {
      accessorKey: "cv",
      header: () => <DataTableColumnHeader title="CV" sortKey="cv" />,
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.cv.toFixed(2)}</span>
      ),
    },
    {
      accessorKey: "riskScore",
      header: () => (
        <DataTableColumnHeader title="Risk score" sortKey="riskScore" />
      ),
      cell: ({ row }) => (
        <span className="tabular-nums font-semibold">
          {formatNumber(row.original.riskScore)}
        </span>
      ),
    },
    {
      accessorKey: "tier",
      header: () => <DataTableColumnHeader title="Tier" sortKey="tier" />,
      cell: ({ row }) => {
        const tier = row.original.tier;
        return (
          <Badge
            variant="outline"
            className={cn("h-5 px-1.5 text-[10px]", TIER_COLORS[tier] ?? "")}
          >
            {tier}
          </Badge>
        );
      },
    },
    {
      id: "flags",
      header: "Flags",
      cell: ({ row }) => <FlagBadges row={row.original} />,
    },
  );

  if (owner) {
    cols.push({
      id: "retune",
      header: () => <span className="sr-only">Re-tune</span>,
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2"
          onClick={() => owner.onRetune(row.original.packId)}
        >
          <SlidersHorizontal className="size-3.5" />
          Re-tune
        </Button>
      ),
    });
  }

  return cols;
}

export function DoctorTable({
  rows,
  isOwner = false,
}: {
  rows: PackRiskRow[];
  /** Owner-only: renders the selection column, the per-row + bulk re-tune UI. */
  isOwner?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const nameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.packId, r.name);
    return m;
  }, [rows]);

  // Drop any selected id that's no longer in the current (filtered) row set so
  // the bulk count + payload never reference a row the operator can't see.
  React.useEffect(() => {
    setSelected((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (nameById.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [nameById]);

  const toggle = React.useCallback((packId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(packId)) next.delete(packId);
      else next.add(packId);
      return next;
    });
  }, []);

  const toggleAll = React.useCallback((packIds: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of packIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  // Per-row "Re-tune" deep-links into the Retune workspace: the drawer's
  // lever form died with V2 — the workspace's `planPackTune` plan is the one
  // brain, and `?pack=<id>` selects + plans the pack on arrival.
  const onRetune = React.useCallback(
    (packId: string) => {
      router.push(`/pack-studio/retune?pack=${packId}`);
    },
    [router],
  );

  const allOnPage = React.useMemo(() => rows.map((r) => r.packId), [rows]);

  const owner: OwnerControls | null = React.useMemo(
    () =>
      isOwner
        ? { selected, toggle, toggleAll, allOnPage, onRetune }
        : null,
    [isOwner, selected, toggle, toggleAll, allOnPage, onRetune],
  );

  const columns = React.useMemo(() => buildColumns(owner), [owner]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  const columnCount = table.getAllColumns().length;

  const selectedRows = React.useMemo(
    () =>
      Array.from(selected)
        .filter((id) => nameById.has(id))
        .map((id) => ({ packId: id, name: nameById.get(id)! })),
    [selected, nameById],
  );

  return (
    <div className="space-y-3">
      {isOwner && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {selectedRows.length > 0
              ? `${selectedRows.length} selected`
              : "Select packs to bulk re-tune, or re-tune a single pack from its row."}
          </p>
          <BulkRetuneButton selected={selectedRows} />
        </div>
      )}

      <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
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
              <TableCell colSpan={columnCount} className="p-0">
                <EmptyState
                  icon={Stethoscope}
                  title="No packs match these filters"
                  description="Adjust or clear the filters to see scored packs."
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
