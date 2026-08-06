"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Users, ChevronRight } from "lucide-react";
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
import { StepUpField } from "@/components/step-up-field";
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
import { EmptyState } from "@/components/empty-state";
import { ROLE_COLORS, USER_STATUS_COLORS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

// ── Persistent selection store ────────────────────────────────────────
// Lives OUTSIDE React render so it survives re-renders from search/filter/sort.
const globalSelection = new Map<string, { username: string | null; email: string | null }>();

function useSelection() {
  // Monotonic version counter that bumps on EVERY mutation. Using this as
  // the dep for `isSelected` (instead of `globalSelection.size`) keeps the
  // callback identity correct even for same-size swaps — e.g. deselecting A
  // while selecting B leaves `.size` unchanged but must still invalidate any
  // memoized consumer of `isSelected`.
  const [version, bump] = React.useReducer((c: number) => c + 1, 0);

  const toggle = React.useCallback((row: UserRow) => {
    if (globalSelection.has(row.id)) {
      globalSelection.delete(row.id);
    } else {
      globalSelection.set(row.id, { username: row.username, email: row.email });
    }
    bump();
  }, []);

  const toggleAll = React.useCallback((rows: UserRow[], checked: boolean) => {
    for (const row of rows) {
      if (checked) {
        globalSelection.set(row.id, { username: row.username, email: row.email });
      } else {
        globalSelection.delete(row.id);
      }
    }
    bump();
  }, []);

  const clear = React.useCallback(() => {
    globalSelection.clear();
    bump();
  }, []);

  const isSelected = React.useCallback(
    (id: string) => globalSelection.has(id),
    // Re-derive on every mutation via the version counter, not on `.size`
    // (which misses equal-size add/remove swaps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
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

/**
 * `degraded` = the server list query failed/timed out and the page passed
 * an EMPTY fallback slice. The empty states must say so — rendering the
 * normal "No users found — try adjusting your search" copy for a failure
 * tells the admin a lie ("there are zero matches") when the truth is
 * "the query never answered".
 */
export function UsersDataTable({
  data,
  degraded = false,
}: {
  data: UserRow[];
  degraded?: boolean;
}) {
  return (
    <UsersSortProvider initialRows={data}>
      {(rows) => <Inner rows={rows} degraded={degraded} />}
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
          <DialogTitle className="text-rose-600 dark:text-rose-400">
            Delete {ids.length} user{ids.length !== 1 ? "s" : ""} permanently
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will <span className="font-semibold text-rose-600 dark:text-rose-400">permanently delete</span> the
            following users and all their data. This cannot be undone.
          </p>
          <div className="max-h-[200px] overflow-y-auto rounded-md border bg-muted/30 p-2">
            {labels.map((label, i) => (
              <div key={ids[i]} className="text-xs py-0.5 font-mono">
                {label}
              </div>
            ))}
          </div>
          <StepUpField value={totpCode} onChange={setTotpCode} />
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
        "flex items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0 transition-colors",
        selected ? "bg-accent/30" : "active:bg-accent/20",
      )}
    >
      {/* Negative-margin padding wrapper enlarges the thumb hit-area
          (~40px) without changing the visual checkbox size or the row
          layout. */}
      <span
        className="-m-2 p-2 inline-flex shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={`Select ${row.username ?? row.email ?? "user"}`}
        />
      </span>
      <button
        type="button"
        onClick={onNavigate}
        className="flex min-h-[40px] flex-1 items-center gap-3 text-left min-w-0"
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
              pnlIsUserProfit && "text-rose-600 dark:text-rose-400",
              pnlIsUserLoss && "text-emerald-600 dark:text-emerald-400",
              !pnlIsUserProfit && !pnlIsUserLoss && "text-muted-foreground",
            )}
          >
            {row.pnl >= 0 ? "+" : ""}
            {formatCurrency(row.pnl)} P&L
          </div>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
      </button>
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────

function Inner({ rows, degraded }: { rows: UserRow[]; degraded: boolean }) {
  const router = useRouter();
  const sel = useSelection();
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const emptyTitle = degraded ? "Couldn't load users" : "No users found";
  const emptyDescription = degraded
    ? "The query failed or timed out — this is not an empty result. Refresh to retry."
    : "Try adjusting your search or filters.";

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
          <div className="rounded-xl border">
            <EmptyState
              icon={Users}
              title={emptyTitle}
              description={emptyDescription}
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
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
        <div className="rounded-xl border overflow-x-auto">
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
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length + 1} className="p-0">
                    <EmptyState
                      icon={Users}
                      title={emptyTitle}
                      description={emptyDescription}
                      compact
                    />
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
