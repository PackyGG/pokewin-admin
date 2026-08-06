"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { CreatorRewardClaimRow } from "@/lib/creator-vip/queries";

import {
  ClaimActionsCell,
  ClaimAgeCell,
  ClaimAmountCell,
  ClaimBasisCell,
  ClaimClaimantCell,
  ClaimProgramCell,
  ClaimRow,
  ClaimStatusCell,
} from "./claim-row";
import { QueuePager } from "./queue-pager";

/** Claims per page. Enough to work a queue without scrolling for a minute. */
const PAGE_SIZE = 20;

/** Pending first, then newest — the order a reviewer actually works in. */
const STATUS_RANK: Record<CreatorRewardClaimRow["status"], number> = {
  pending: 0,
  rejected: 1,
  approved: 2,
};

/**
 * Sortable column header.
 *
 * NOT `DataTableColumnHeader` from `src/components/data-table/`: that one sorts
 * by pushing `?sortBy=` and re-running a server query. This queue holds its
 * whole capped window in memory and is narrowed by client-side search and
 * filters, so a URL round-trip would re-fetch data the browser already has and
 * still couldn't sort the filtered set. Same micro-caps chrome, local state.
 */
function SortHeader({
  column,
  title,
  className,
}: {
  column: Column<CreatorRewardClaimRow, unknown>;
  title: string;
  className?: string;
}) {
  const sorted = column.getIsSorted();
  const next = sorted === "asc" ? "descending" : "ascending";

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "-ml-3 h-8 px-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground",
        className,
      )}
      onClick={() => column.toggleSorting(sorted === "asc")}
      aria-label={
        sorted
          ? `Sort by ${title}, currently ${sorted === "asc" ? "ascending" : "descending"}. Activate to sort ${next}.`
          : `Sort by ${title}. Activate to sort ${next}.`
      }
    >
      {title}
      {sorted === "asc" ? (
        <ArrowUp className="ml-1 size-3" aria-hidden />
      ) : sorted === "desc" ? (
        <ArrowDown className="ml-1 size-3" aria-hidden />
      ) : (
        <ArrowUpDown className="ml-1 size-3" aria-hidden />
      )}
    </Button>
  );
}

/**
 * The claim queue as a real table.
 *
 * ── WHY THIS REPLACED THE BESPOKE GRID ────────────────────────────────────
 * The old row was a hand-rolled four-track CSS grid with NO header row, so the
 * two money columns — the wager a claim consumes and the dollars it pays —
 * were unlabelled numbers sitting next to each other. On a screen whose whole
 * job is deciding whether to pay, that is the one thing that must not be
 * ambiguous. TanStack also brings the sorting the queue never had: biggest
 * payout first, or oldest first, without re-querying.
 *
 * The card rendering survives below `lg`, where a seven-column table is
 * unreadable — same cells, same flags, same buttons (see `claim-row.tsx`), so
 * the two can't drift.
 */
export function ClaimsQueue({
  claims,
  userHrefBase,
  noun,
  selectable = false,
  rowSelection,
  onRowSelectionChange,
}: {
  claims: CreatorRewardClaimRow[];
  userHrefBase: string;
  /** Plural noun for the pager's range summary. */
  noun: string;
  /** Pending queue only — decided claims have nothing to bulk-approve. */
  selectable?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (next: RowSelectionState) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<ColumnDef<CreatorRewardClaimRow>[]>(() => {
    const selectColumn: ColumnDef<CreatorRewardClaimRow> = {
      id: "select",
      enableSorting: false,
      header: ({ table }) => {
        // Row-level helpers, not page-level: base-ui's Checkbox has no
        // tri-state, so "some selected" reads as checked and one click on the
        // header flips the whole set off. Matches the promo-codes table.
        const checked =
          table.getIsAllRowsSelected() || table.getIsSomeRowsSelected();
        return (
          <Checkbox
            checked={checked}
            onCheckedChange={(v) => table.toggleAllRowsSelected(v === true)}
            aria-label="Select all claims on this page"
          />
        );
      },
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(v === true)}
          aria-label={`Select ${row.original.username ?? row.original.userId}'s claim`}
        />
      ),
    };

    const rest: ColumnDef<CreatorRewardClaimRow>[] = [
      {
        id: "claimant",
        accessorFn: (c) => (c.username ?? c.userId).toLowerCase(),
        header: ({ column }) => <SortHeader column={column} title="Claimant" />,
        cell: ({ row }) => (
          <ClaimClaimantCell claim={row.original} userHrefBase={userHrefBase} />
        ),
      },
      {
        id: "program",
        accessorFn: (c) => c.programName.toLowerCase(),
        header: ({ column }) => <SortHeader column={column} title="Program" />,
        cell: ({ row }) => <ClaimProgramCell claim={row.original} />,
      },
      {
        id: "basis",
        enableSorting: false,
        header: () => (
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Wager basis
          </span>
        ),
        cell: ({ row }) => <ClaimBasisCell claim={row.original} />,
      },
      {
        id: "amount",
        accessorFn: (c) => c.amountUsd,
        header: ({ column }) => (
          <SortHeader column={column} title="Payout" className="-mr-3 ml-0" />
        ),
        cell: ({ row }) => <ClaimAmountCell claim={row.original} />,
      },
      {
        id: "status",
        accessorFn: (c) => STATUS_RANK[c.status],
        header: ({ column }) => <SortHeader column={column} title="Status" />,
        cell: ({ row }) => <ClaimStatusCell claim={row.original} />,
      },
      {
        id: "requested",
        accessorFn: (c) => new Date(c.requestedAt).getTime(),
        header: ({ column }) => <SortHeader column={column} title="Filed" />,
        cell: ({ row }) => <ClaimAgeCell claim={row.original} />,
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => <ClaimActionsCell claim={row.original} />,
      },
    ];

    return selectable ? [selectColumn, ...rest] : rest;
  }, [selectable, userHrefBase]);

  const table = useReactTable({
    data: claims,
    columns,
    state: { sorting, ...(selectable ? { rowSelection: rowSelection ?? {} } : {}) },
    onSortingChange: setSorting,
    ...(selectable
      ? {
          enableRowSelection: true,
          onRowSelectionChange: (updater) => {
            const current = rowSelection ?? {};
            onRowSelectionChange?.(
              typeof updater === "function" ? updater(current) : updater,
            );
          },
        }
      : {}),
    // Keyed by claim id so a re-render (or a revalidation that reorders the
    // list) can't hand a selection to a different claim.
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  const rows = table.getRowModel().rows;
  const { pageIndex } = table.getState().pagination;
  const pageCount = table.getPageCount();
  const total = claims.length;
  const first = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const last = Math.min((pageIndex + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-3">
      {/* Cards below lg — a seven-column table does not survive a phone. */}
      <div className="space-y-2 lg:hidden">
        {rows.map((row) => (
          <ClaimRow
            key={row.id}
            claim={row.original}
            userHrefBase={userHrefBase}
            selectable={selectable && row.getCanSelect()}
            selected={row.getIsSelected()}
            onSelectedChange={(next) => row.toggleSelected(next)}
          />
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-md border lg:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      aria-sort={
                        !header.column.getCanSort()
                          ? undefined
                          : sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : "none"
                      }
                      className={cn(header.id === "amount" && "text-right")}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="align-top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <QueuePager
        page={pageIndex + 1}
        pageCount={pageCount}
        first={first}
        last={last}
        total={total}
        noun={noun}
        onPageChange={(page) => table.setPageIndex(page - 1)}
      />
    </div>
  );
}
