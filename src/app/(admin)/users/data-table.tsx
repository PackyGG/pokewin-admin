"use client";

import * as React from "react";
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
import { columns, type UserRow } from "./columns";
import { UsersSortProvider } from "./sort-context";

export function UsersDataTable({ data }: { data: UserRow[] }) {
  return (
    <UsersSortProvider initialRows={data}>
      {(rows) => <Inner rows={rows} />}
    </UsersSortProvider>
  );
}

/**
 * FLIP-style row animation. Captures both top AND left positions of every row
 * before the React commit, then on the next layout subtracts the new position
 * and applies an inverse transform that's transitioned to zero — giving the
 * row a smooth glide on both axes.
 */
function useFlipRows(orderKey: string) {
  const tbodyRef = React.useRef<HTMLTableSectionElement | null>(null);
  const positionsRef = React.useRef<Map<string, { top: number; left: number }>>(
    new Map(),
  );

  React.useLayoutEffect(() => {
    const container = tbodyRef.current;
    if (!container) return;
    const rows = Array.from(
      container.querySelectorAll<HTMLTableRowElement>("tr[data-row-id]"),
    );
    const previous = positionsRef.current;
    const next = new Map<string, { top: number; left: number }>();

    rows.forEach((row) => {
      const id = row.getAttribute("data-row-id");
      if (!id) return;
      const rect = row.getBoundingClientRect();
      next.set(id, { top: rect.top, left: rect.left });
      const prev = previous.get(id);
      if (!prev) {
        // Newly entered row — fade it in
        row.style.transition = "none";
        row.style.opacity = "0";
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        row.offsetHeight;
        row.style.transition = "opacity 280ms ease-out";
        row.style.opacity = "1";
        return;
      }
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (dx === 0 && dy === 0) return;
      row.style.transition = "none";
      row.style.transform = `translate(${dx}px, ${dy}px)`;
      // Force reflow before applying the animation
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      row.offsetHeight;
      row.style.transition = "transform 380ms cubic-bezier(0.22, 1, 0.36, 1)";
      row.style.transform = "translate(0, 0)";
    });

    positionsRef.current = next;
  }, [orderKey]);

  return tbodyRef;
}

/**
 * Lock the table column widths after the first paint so that swapping row
 * content (different badges, longer usernames, etc.) doesn't make the layout
 * jump.
 */
function useLockedColumnWidths(
  wrapperRef: React.RefObject<HTMLDivElement | null>,
) {
  React.useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const table = wrapper.querySelector<HTMLTableElement>("table");
    if (!table) return;
    if (table.style.tableLayout === "fixed") return;
    const ths = Array.from(
      table.querySelectorAll<HTMLTableCellElement>("thead th"),
    );
    if (ths.length === 0) return;
    const widths = ths.map((th) => th.getBoundingClientRect().width);
    ths.forEach((th, i) => {
      th.style.width = `${widths[i]}px`;
    });
    table.style.tableLayout = "fixed";
  }, [wrapperRef]);
}

function Inner({ rows }: { rows: UserRow[] }) {
  const router = useRouter();
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
  });

  const orderKey = rows.map((r) => r.id).join(",");
  const tbodyRef = useFlipRows(orderKey);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  useLockedColumnWidths(wrapperRef);

  return (
    <div ref={wrapperRef} className="rounded-md border">
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
        <TableBody ref={tbodyRef}>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-row-id={row.id}
                className="cursor-pointer hover:bg-accent/40 will-change-transform"
                onClick={() => router.push(`/users/${row.original.id}`)}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="overflow-hidden">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                No users found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
