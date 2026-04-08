"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import {
  TablePendingProvider,
  useTablePending,
} from "@/components/data-table/table-pending-context";
import { columns, type UserRow } from "./columns";
import { cn } from "@/lib/utils";

export function UsersDataTable({ data }: { data: UserRow[] }) {
  return (
    <TablePendingProvider>
      <UsersDataTableInner data={data} />
    </TablePendingProvider>
  );
}

function UsersDataTableInner({ data }: { data: UserRow[] }) {
  const router = useRouter();
  const { pending, setPending } = useTablePending();
  const searchParams = useSearchParams();

  // Whenever a new server-rendered `data` prop arrives, the fetch is done.
  React.useEffect(() => {
    setPending(false);
    // We intentionally only depend on data and searchParams string;
    // setPending is stable from the context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, searchParams.toString()]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="relative rounded-md border">
      {pending && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-t-md bg-primary/20">
          <div className="h-full w-1/3 animate-pulse bg-primary" />
        </div>
      )}
      <Table
        className={cn(
          "transition-opacity duration-150",
          pending && "opacity-50",
        )}
      >
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
              <TableRow
                key={row.id}
                className="cursor-pointer hover:bg-accent/40"
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
