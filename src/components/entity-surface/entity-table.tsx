"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { useUrlSort } from "@/lib/entity-surface/use-url-state";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  EntityTable  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * A dense, compact, sortable data-table foundation for operational ENTITY
 * surfaces (the `/packs` + `/cards` rebuild). It is the "scan + triage + act"
 * table the discovery maps asked for, built on the existing shadcn `<Table>`
 * primitives + the shared URL-sort hook — no `@tanstack/react-table` instance
 * is needed for these server-paginated, server-sorted lists (the data already
 * arrives in the right order/page), so this stays lean and declarative.
 *
 * Capabilities:
 *   - Column-driven: pass a `columns` spec; each column renders a cell from a
 *     row. Columns can declare a `sortKey` → the header becomes a sort toggle
 *     wired to the URL (`?sortBy`/`?sortOrder`) via `useUrlSort`, fixing the
 *     "sort is unreachable" gap (the queries support it; the UI never surfaced
 *     it). Server re-sorts + re-paginates; this component only writes the URL.
 *   - Sticky header: the header row pins to the top of the scroll container so
 *     column meaning stays visible while scrolling a long list.
 *   - Selection: an optional leading checkbox column with a header
 *     select-all-visible (indeterminate aware) and SHIFT-CLICK range select —
 *     the bulk-grooming ergonomics /cards needs. Selection state is owned by
 *     the caller (so it can persist across pages); this component is
 *     controlled.
 *   - Row click: optional `onRowClick` opens an inspector/drawer WITHOUT
 *     leaving the page. Clicks originating inside an interactive cell element
 *     (checkbox, button, link, menu) are ignored so row-nav never fights a
 *     control.
 *   - Long-text-safe: cells truncate with an automatic `title` tooltip unless
 *     a column opts out — no layout-breaking overflow on long names.
 *   - Virtualization-ready: rows render through a single `renderRow` map and
 *     row height is uniform, so a windowing layer can be dropped in later
 *     without changing the column API.
 *
 * Strict-typed generic over the row type. No new deps.
 */

export type EntityColumn<T> = {
  /** Stable column id (used as React key + for header cell). */
  id: string;
  /** Header label. */
  header: React.ReactNode;
  /** Cell renderer. Receives the row. */
  cell: (row: T) => React.ReactNode;
  /**
   * When set, the header becomes a sort toggle writing this key to `?sortBy`.
   * Must match a value the server list query whitelists (e.g. "revenue",
   * "house_edge", "price", "name").
   */
  sortKey?: string;
  /** Right-align the header + cell (numeric/money columns). */
  align?: "left" | "right" | "center";
  /** Fixed/ível width hint (CSS length) applied to the column. */
  width?: string;
  /** Disable the automatic truncate + title on this column's cell wrapper. */
  noTruncate?: boolean;
  /** Hide below this Tailwind breakpoint (e.g. "md" → `hidden md:table-cell`). */
  hideBelow?: "sm" | "md" | "lg" | "xl";
  /** Extra classes on the cell `<td>`. */
  cellClassName?: string;
  /** Extra classes on the header `<th>`. */
  headerClassName?: string;
};

const HIDE_BELOW_CLASS: Record<NonNullable<EntityColumn<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

function alignClass(align: EntityColumn<unknown>["align"]): string {
  return align === "right"
    ? "text-right"
    : align === "center"
      ? "text-center"
      : "text-left";
}

// ─── Sort header ────────────────────────────────────────────────────────────

function SortableHeader({
  label,
  sortKey,
  align,
}: {
  label: React.ReactNode;
  sortKey: string;
  align?: EntityColumn<unknown>["align"];
}) {
  const { sortBy, sortOrder, toggleSort, isPending } = useUrlSort();
  const isActive = sortBy === sortKey;
  return (
    <button
      type="button"
      onClick={() => toggleSort(sortKey)}
      disabled={isPending}
      aria-label={`Sort by ${typeof label === "string" ? label : sortKey}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm text-xs font-semibold uppercase tracking-wider text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60",
        align === "right" && "flex-row-reverse",
        isActive && "text-foreground",
      )}
    >
      {label}
      {isActive ? (
        sortOrder === "asc" ? (
          <ArrowUp className="size-3" />
        ) : (
          <ArrowDown className="size-3" />
        )
      ) : (
        <ChevronsUpDown className="size-3 opacity-50" />
      )}
    </button>
  );
}

// ─── Cell wrapper (truncate + title) ────────────────────────────────────────

function CellInner({
  children,
  noTruncate,
}: {
  children: React.ReactNode;
  noTruncate?: boolean;
}) {
  if (noTruncate) return <>{children}</>;
  // Only add a `title` when the cell content is a plain string (so a tooltip
  // helps for long text); rich nodes carry their own affordances.
  const title = typeof children === "string" ? children : undefined;
  return (
    <span className="block truncate" title={title}>
      {children}
    </span>
  );
}

// ─── Row select checkbox (shift-range aware) ────────────────────────────────

/**
 * A controlled selection checkbox with reliable SHIFT-RANGE capture.
 *
 * The toggle itself runs through base-ui's `onCheckedChange` (one path — no
 * double-fire). To know whether Shift was held, we record the modifier on the
 * `mousedown` that precedes the click into a ref; `onCheckedChange` then reads
 * it. A keyboard toggle (Space/Enter) leaves the ref `false`, so it's always a
 * single toggle. The wrapping span stops propagation so the row-click guard
 * never also fires.
 */
function RowSelectCheckbox({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: (next: boolean, shiftKey: boolean) => void;
  label: string;
}) {
  const shiftRef = React.useRef(false);
  return (
    <span
      className="inline-flex"
      onMouseDown={(e) => {
        shiftRef.current = e.shiftKey;
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => {
          onToggle(Boolean(v), shiftRef.current);
          shiftRef.current = false;
        }}
        aria-label={label}
      />
    </span>
  );
}

// ─── EntityTable ────────────────────────────────────────────────────────────

export type EntityTableProps<T> = {
  rows: T[];
  columns: EntityColumn<T>[];
  /** Unique key for a row. */
  rowKey: (row: T) => string;
  /** Row click opens an inspector/drawer. Ignored if a control was clicked. */
  onRowClick?: (row: T) => void;
  /** Highlight this row key (e.g. the row whose inspector is open). */
  activeRowKey?: string | null;

  // — selection (controlled) —
  /** Enable the leading checkbox column. */
  selectable?: boolean;
  /** Currently-selected row keys (owned by caller so it can persist). */
  selected?: Set<string>;
  /** Toggle one row's selection. `shiftKey` requests range-select. */
  onToggleRow?: (key: string, next: boolean, shiftKey: boolean) => void;
  /** Toggle every currently-visible row. */
  onToggleAllVisible?: (next: boolean) => void;

  /** Uniform body-row height in px (keeps skeletons/virtualization aligned). */
  rowHeight?: number;
  /** Max height of the scroll area before the body scrolls under the sticky
   * header (CSS length). Omit to let the table grow with its container. */
  maxBodyHeight?: string;
  /** Rendered when `rows` is empty. */
  emptyState?: React.ReactNode;
  className?: string;
};

export function EntityTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  activeRowKey,
  selectable = false,
  selected,
  onToggleRow,
  onToggleAllVisible,
  rowHeight = 48,
  maxBodyHeight,
  emptyState,
  className,
}: EntityTableProps<T>) {
  const visibleKeys = React.useMemo(
    () => rows.map((r) => rowKey(r)),
    [rows, rowKey],
  );
  const allVisibleSelected =
    selectable &&
    visibleKeys.length > 0 &&
    selected != null &&
    visibleKeys.every((k) => selected.has(k));
  const someVisibleSelected =
    selectable &&
    !allVisibleSelected &&
    selected != null &&
    visibleKeys.some((k) => selected.has(k));

  // Guard row-click so clicking an interactive control (checkbox, button,
  // link, the kebab menu) never also triggers row navigation.
  const handleRowClick = React.useCallback(
    (row: T, e: React.MouseEvent) => {
      if (!onRowClick) return;
      const el = e.target as HTMLElement;
      if (el.closest("button, a, input, [role=checkbox], [data-no-row-click]")) {
        return;
      }
      onRowClick(row);
    },
    [onRowClick],
  );

  const colCount = columns.length + (selectable ? 1 : 0);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card",
        className,
      )}
    >
      {/* Single scroll container so the sticky header resolves against THIS
          element (no nested scroll from the shadcn Table wrapper). The raw
          <table> reuses the same sub-primitives (thead/tbody/tr/th/td). */}
      <div
        className="relative w-full overflow-auto"
        style={maxBodyHeight ? { maxHeight: maxBodyHeight } : undefined}
      >
        <table className="w-full caption-bottom border-separate border-spacing-0 text-sm">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {selectable && (
                <TableHead
                  className="sticky top-0 z-10 w-10 border-b bg-muted/80 backdrop-blur supports-backdrop-filter:bg-muted/60"
                  data-no-row-click
                >
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={someVisibleSelected}
                    onCheckedChange={(v) => onToggleAllVisible?.(Boolean(v))}
                    aria-label="Select all visible rows"
                  />
                </TableHead>
              )}
              {columns.map((col) => (
                <TableHead
                  key={col.id}
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    "sticky top-0 z-10 border-b bg-muted/80 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur supports-backdrop-filter:bg-muted/60",
                    alignClass(col.align),
                    col.hideBelow && HIDE_BELOW_CLASS[col.hideBelow],
                    col.headerClassName,
                  )}
                >
                  {col.sortKey ? (
                    <SortableHeader
                      label={col.header}
                      sortKey={col.sortKey}
                      align={col.align}
                    />
                  ) : (
                    col.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colCount} className="p-0">
                  {emptyState}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const key = rowKey(row);
                const isSelected = Boolean(selectable && selected?.has(key));
                const isActive = activeRowKey === key;
                return (
                  <TableRow
                    key={key}
                    data-state={isSelected ? "selected" : undefined}
                    onClick={
                      onRowClick ? (e) => handleRowClick(row, e) : undefined
                    }
                    className={cn(
                      "border-b transition-colors",
                      onRowClick && "cursor-pointer",
                      isActive && "bg-accent/40",
                      !isActive && "hover:bg-muted/50",
                    )}
                    style={{ height: rowHeight }}
                  >
                    {selectable && (
                      <TableCell className="w-10" data-no-row-click>
                        <RowSelectCheckbox
                          checked={isSelected}
                          onToggle={(next, shift) =>
                            onToggleRow?.(key, next, shift)
                          }
                          label="Select row"
                        />
                      </TableCell>
                    )}
                    {columns.map((col) => (
                      <TableCell
                        key={col.id}
                        style={col.width ? { width: col.width } : undefined}
                        className={cn(
                          "max-w-0 text-sm",
                          alignClass(col.align),
                          col.hideBelow && HIDE_BELOW_CLASS[col.hideBelow],
                          col.cellClassName,
                        )}
                      >
                        <CellInner noTruncate={col.noTruncate}>
                          {col.cell(row)}
                        </CellInner>
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </table>
      </div>
    </div>
  );
}

/**
 * Shared range-select reducer helper for the caller that owns selection state.
 * Given the ordered visible keys, the anchor key, and the just-clicked key,
 * returns the set of keys spanning the two (inclusive). The caller keeps the
 * last-clicked key as the anchor for the NEXT shift-click.
 *
 *   const next = rangeSelectKeys(visibleKeys, anchorKey, clickedKey);
 *
 * This lets `/cards` implement persistent, cross-page selection with shift-
 * range without re-deriving the span math.
 */
export function rangeSelectKeys(
  orderedKeys: string[],
  anchorKey: string | null,
  clickedKey: string,
): string[] {
  if (!anchorKey || anchorKey === clickedKey) return [clickedKey];
  const a = orderedKeys.indexOf(anchorKey);
  const b = orderedKeys.indexOf(clickedKey);
  if (a === -1 || b === -1) return [clickedKey];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return orderedKeys.slice(lo, hi + 1);
}
