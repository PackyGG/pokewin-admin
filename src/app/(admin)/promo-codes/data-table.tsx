"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type RowSelectionState,
} from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Ticket } from "lucide-react";
import { columns } from "./columns";
import type { PromoCodeListItem } from "@/lib/queries/promo-codes";
import { formatCurrency } from "@/lib/utils/format";
import { MobileCard } from "@/components/data-table/mobile-card-list";
import { deletePromoCodesBulk } from "./actions";

function codeStatus(row: PromoCodeListItem): { label: string; cls: string } {
  const isExpired = row.expiresAt && new Date(row.expiresAt) < new Date();
  const isUsedUp = row.redemptionCount >= row.maxUses;
  if (isExpired)
    return {
      label: "Expired",
      cls: "border-rose-500/30 bg-rose-500/15 text-rose-400",
    };
  if (isUsedUp)
    return {
      label: "Used up",
      cls: "border-amber-500/30 bg-amber-500/15 text-amber-400",
    };
  return {
    label: "Active",
    cls: "border-emerald-500/30 bg-emerald-500/15 text-emerald-400",
  };
}

function PromoMobileCard({ code }: { code: PromoCodeListItem }) {
  const router = useRouter();
  const status = codeStatus(code);
  const display = code.code ?? code.codeHash.slice(0, 12) + "…";
  return (
    <MobileCard
      onClick={() => router.push(`/promo-codes/${code.id}`)}
      leading={
        <div className="flex size-9 items-center justify-center rounded-md bg-amber-500/10 shrink-0">
          <Ticket className="size-4 text-amber-500" />
        </div>
      }
      primary={
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm">{display}</span>
          <Badge variant="outline" className={"h-4 px-1 text-[9px] " + status.cls}>
            {status.label}
          </Badge>
        </span>
      }
      secondary={
        <span>
          Min level {code.minimumLevel} · {code.redemptionCount}/{code.maxUses} used
        </span>
      }
      trailing={
        <div>
          {/* House-POV: promo value is house-paid credit → house liability → rose. */}
          <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(code.value)}
          </div>
        </div>
      }
      showChevron
    />
  );
}

export function PromoCodesDataTable({ data }: { data: PromoCodeListItem[] }) {
  // Row-selection state — drives the "Delete N selected" bulk-action
  // bar that appears above the table when at least one row is checked.
  // TanStack stores selection keyed by row.id (defaults to row index);
  // we map back to the underlying promo_code.id via getRowId so refresh
  // doesn't shuffle which rows stay selected.
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const table = useReactTable({
    data,
    columns,
    state: { rowSelection },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
  });

  const selectedIds = useMemo(
    () =>
      table
        .getFilteredSelectedRowModel()
        .rows.map((r) => r.original.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowSelection, data],
  );

  return (
    <>
      {/* Bulk-action bar — only renders when something is selected, so
          desktop and mobile see the same "delete N selected" entry
          point above the table. */}
      {selectedIds.length > 0 && (
        <BulkActionsBar
          selectedIds={selectedIds}
          onDone={() => setRowSelection({})}
        />
      )}

      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
            No promo codes found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((code) => (
              <PromoMobileCard key={code.id} code={code} />
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
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  className={
                    row.getIsSelected() ? "bg-muted/30" : undefined
                  }
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
                  No promo codes found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/**
 * Bulk-delete bar. Same controlled-AlertDialog pattern as the row-level
 * RowDeleteButton in columns.tsx — explicit `open` state so we can close
 * the popup after a successful delete (AlertDialogAction in this codebase
 * is just a styled Button, it doesn't auto-close).
 */
function BulkActionsBar({
  selectedIds,
  onDone,
}: {
  selectedIds: string[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleBulkDelete() {
    startTransition(async () => {
      try {
        const result = await deletePromoCodesBulk(selectedIds);
        toast.success(
          result.deleted === 1
            ? "1 promo code deleted"
            : `${result.deleted} promo codes deleted`,
        );
        setOpen(false);
        onDone();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to delete");
        setOpen(false);
      }
    });
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <span className="text-sm">
        <span className="font-semibold">{selectedIds.length}</span>{" "}
        {selectedIds.length === 1 ? "promo code" : "promo codes"} selected
      </span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={isPending}>
          Clear
        </Button>
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger
            render={
              <Button variant="destructive" size="sm" disabled={isPending} />
            }
          >
            <Trash2 className="size-3.5" />
            Delete selected
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {selectedIds.length}{" "}
                {selectedIds.length === 1 ? "promo code" : "promo codes"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. All selected promo codes will
                be permanently deleted along with their redemption history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleBulkDelete}
                disabled={isPending}
              >
                {isPending ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
