"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { columns, type UserRow } from "./columns";
import { UsersSortProvider } from "./sort-context";
import { bulkDeleteUsers } from "./actions";
import { ROLE_COLORS, USER_STATUS_COLORS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

// ── Persistent selection store ────────────────────────────────────────
// Lives OUTSIDE React render so it survives re-renders from search/filter/sort.
const globalSelection = new Map<string, { username: string | null; email: string | null }>();

function useSelection() {
  const [, forceUpdate] = React.useReducer((c: number) => c + 1, 0);

  const toggle = React.useCallback((row: UserRow) => {
    if (globalSelection.has(row.id)) {
      globalSelection.delete(row.id);
    } else {
      globalSelection.set(row.id, { username: row.username, email: row.email });
    }
    forceUpdate();
  }, []);

  const toggleAll = React.useCallback((rows: UserRow[], checked: boolean) => {
    for (const row of rows) {
      if (checked) {
        globalSelection.set(row.id, { username: row.username, email: row.email });
      } else {
        globalSelection.delete(row.id);
      }
    }
    forceUpdate();
  }, []);

  const clear = React.useCallback(() => {
    globalSelection.clear();
    forceUpdate();
  }, []);

  const isSelected = React.useCallback(
    (id: string) => globalSelection.has(id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [globalSelection.size],
  );

  return {
    selected: globalSelection,
    count: globalSelection.size,
    toggle,
    toggleAll,
    clear,
    isSelected,
  };
}

// ── Main export ───────────────────────────────────────────────────────

export function UsersDataTable({ data }: { data: UserRow[] }) {
  return (
    <UsersSortProvider initialRows={data}>
      {(rows) => <Inner rows={rows} />}
    </UsersSortProvider>
  );
}

// ── Bulk Delete Dialog ────────────────────────────────────────────────

function BulkDeleteDialog({
  open,
  onOpenChange,
  selection,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selection: Map<string, { username: string | null; email: string | null }>;
  onDone: () => void;
}) {
  const [totpCode, setTotpCode] = React.useState("");
  const [isPending, startTransition] = React.useTransition();
  const router = useRouter();
  const ids = [...selection.keys()];
  const labels = ids.map(
    (id) => selection.get(id)?.username ?? selection.get(id)?.email ?? id.slice(0, 8),
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setTotpCode(""); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-rose-400">
            Delete {ids.length} user{ids.length !== 1 ? "s" : ""} permanently
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will <span className="font-semibold text-rose-400">permanently delete</span> the
            following users and all their data. This cannot be undone.
          </p>
          <div className="max-h-[200px] overflow-y-auto rounded-md border bg-muted/30 p-2">
            {labels.map((label, i) => (
              <div key={ids[i]} className="text-xs py-0.5 font-mono">
                {label}
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">2FA Code</Label>
            <Input
              type="text"
              inputMode="numeric"
              placeholder="Enter your 6-digit code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              maxLength={6}
              autoComplete="one-time-code"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            className="w-full sm:w-auto"
            disabled={!totpCode.trim() || isPending}
            onClick={() => {
              startTransition(async () => {
                try {
                  await bulkDeleteUsers(ids, totpCode.trim());
                  toast.success(`${ids.length} user${ids.length !== 1 ? "s" : ""} deleted`);
                  onDone();
                  onOpenChange(false);
                  router.refresh();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed to delete users");
                }
              });
            }}
          >
            {isPending
              ? "Deleting..."
              : `Delete ${ids.length} user${ids.length !== 1 ? "s" : ""} permanently`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Mobile card row ───────────────────────────────────────────────────

function initialsFor(name: string | null, email: string | null): string {
  const src = name ?? email ?? "?";
  return src.slice(0, 2).toUpperCase();
}

function UserMobileCard({
  row,
  selected,
  onToggle,
  onNavigate,
}: {
  row: UserRow;
  selected: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  // House-POV: positive pnl = user winning = bad for us = rose; negative = green.
  const pnlIsUserProfit = row.pnl > 0;
  const pnlIsUserLoss = row.pnl < 0;
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border/60 px-3 py-3 last:border-b-0 transition-colors",
        selected && "bg-accent/30",
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select ${row.username ?? row.email ?? "user"}`}
      />
      <button
        type="button"
        onClick={onNavigate}
        className="flex flex-1 items-center gap-3 text-left min-w-0"
      >
        <Avatar className="size-9 shrink-0">
          {row.image && <AvatarImage src={row.image} alt="" />}
          <AvatarFallback className="text-xs">
            {initialsFor(row.username, row.email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {row.username ?? row.email ?? "—"}
            </span>
            <Badge
              variant="outline"
              className={cn("h-4 px-1 text-[9px] uppercase", ROLE_COLORS[row.role])}
            >
              {row.role}
            </Badge>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Badge
              variant="outline"
              className={cn(
                "h-4 px-1 text-[9px] capitalize",
                USER_STATUS_COLORS[row.status],
              )}
            >
              {row.status}
            </Badge>
            {row.country && (
              <span className="text-[10px] text-muted-foreground truncate">
                {row.country}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-medium tabular-nums">
            {formatCurrency(row.availableBalance)}
          </div>
          <div
            className={cn(
              "text-[10px] tabular-nums",
              pnlIsUserProfit && "text-rose-400",
              pnlIsUserLoss && "text-emerald-400",
              !pnlIsUserProfit && !pnlIsUserLoss && "text-muted-foreground",
            )}
          >
            {row.pnl >= 0 ? "+" : ""}
            {formatCurrency(row.pnl)} P&L
          </div>
        </div>
      </button>
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────

function Inner({ rows }: { rows: UserRow[] }) {
  const router = useRouter();
  const sel = useSelection();
  const [bulkOpen, setBulkOpen] = React.useState(false);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
  });

  const allOnPageSelected =
    rows.length > 0 && rows.every((r) => sel.isSelected(r.id));

  return (
    <div className="space-y-2">
      {/* Toolbar — shows when selection active */}
      {sel.count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <span className="text-sm font-medium">
            {sel.count} user{sel.count !== 1 ? "s" : ""} selected
          </span>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => setBulkOpen(true)}
          >
            <Trash2 className="size-3" />
            Delete selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={sel.clear}
          >
            Clear selection
          </Button>
        </div>
      )}

      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {rows.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
            No users found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-3 border-b bg-muted/30 px-3 py-2">
              <Checkbox
                checked={allOnPageSelected}
                onCheckedChange={(checked) => sel.toggleAll(rows, !!checked)}
                aria-label="Select all on page"
              />
              <span className="text-xs text-muted-foreground">
                Select all on page
              </span>
            </div>
            {rows.map((row) => (
              <UserMobileCard
                key={row.id}
                row={row}
                selected={sel.isSelected(row.id)}
                onToggle={() => sel.toggle(row)}
                onNavigate={() => router.push(`/users/${row.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden lg:block">
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  <TableHead className="w-10 px-2">
                    <Checkbox
                      checked={allOnPageSelected}
                      onCheckedChange={(checked) =>
                        sel.toggleAll(rows, !!checked)
                      }
                    />
                  </TableHead>
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
                    data-row-id={row.id}
                    className={`cursor-pointer hover:bg-accent/40 ${
                      sel.isSelected(row.id) ? "bg-accent/20" : ""
                    }`}
                    onClick={() => router.push(`/users/${row.original.id}`)}
                  >
                    <TableCell
                      className="w-10 px-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={sel.isSelected(row.id)}
                        onCheckedChange={() => sel.toggle(row.original)}
                      />
                    </TableCell>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="overflow-hidden">
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={columns.length + 1}
                    className="h-24 text-center"
                  >
                    No users found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <BulkDeleteDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        selection={sel.selected}
        onDone={sel.clear}
      />
    </div>
  );
}
