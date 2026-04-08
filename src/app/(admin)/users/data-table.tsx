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
 * FLIP-style row animation: capture each row's bounding rect before the React
 * commit, then on the next layout subtract the new rect, set a translateY for
 * the delta, and clear it on the next frame so the row glides into place.
 */
function useFlipRows(rowKey: string) {
  const containerRef = React.useRef<HTMLTableSectionElement | null>(null);
  const positionsRef = React.useRef<Map<string, number>>(new Map());

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const rows = Array.from(
      container.querySelectorAll<HTMLTableRowElement>("tr[data-row-id]"),
    );
    const previous = positionsRef.current;
    const next = new Map<string, number>();

    rows.forEach((row) => {
      const id = row.getAttribute("data-row-id");
      if (!id) return;
      const top = row.getBoundingClientRect().top;
      next.set(id, top);
      const prev = previous.get(id);
      if (prev !== undefined && prev !== top) {
        const delta = prev - top;
        row.style.transition = "none";
        row.style.transform = `translateY(${delta}px)`;
        // Force reflow before applying the animation
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        row.offsetHeight;
        row.style.transition = "transform 350ms cubic-bezier(0.22, 1, 0.36, 1)";
        row.style.transform = "translateY(0)";
      }
    });

    positionsRef.current = next;
  }, [rowKey]);

  return containerRef;
}

function Inner({ rows }: { rows: UserRow[] }) {
  const router = useRouter();
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
  });

  // Use the row order signature as the key — every reorder re-runs the FLIP.
  const orderKey = rows.map((r) => r.id).join(",");
  const tbodyRef = useFlipRows(orderKey);

  return (
    <div className="rounded-md border">
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
                  <TableCell key={cell.id}>
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
