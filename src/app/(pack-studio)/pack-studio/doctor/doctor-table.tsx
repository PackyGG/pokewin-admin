"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Stethoscope } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { PackRiskRow } from "../_queries/doctor";

/**
 * Pack Doctor scored grid (read-only). Renders the persisted risk rows in a
 * `@tanstack/react-table` shell matching the admin data-table house style,
 * with querystring-driven sortable headers (reusing
 * `DataTableColumnHeader`, keyed on `sortBy`/`sortOrder`).
 *
 * House-POV coloring — these surfaces report risk to the HOUSE, so a metric
 * that favors the player reads as a warning:
 *   • edge below target            → rose  (house giving away margin)
 *   • edge at/above target         → emerald (healthy house margin)
 *   • win-rate higher than typical → rose-leaning amber as it climbs
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

function buildColumns(targetEdge: number): ColumnDef<PackRiskRow>[] {
  return [
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
        const edge = row.original.edge;
        // House-POV: edge below the target = house giving away margin → rose;
        // at/above target = healthy house margin → emerald.
        const healthy = edge >= targetEdge;
        return (
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
  ];
}

export function DoctorTable({
  rows,
  targetEdge,
}: {
  rows: PackRiskRow[];
  targetEdge: number;
}) {
  const table = useReactTable({
    data: rows,
    columns: buildColumns(targetEdge),
    getCoreRowModel: getCoreRowModel(),
  });
  const columnCount = table.getAllColumns().length;

  return (
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
  );
}
