"use client";

import * as React from "react";
import { CheckSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  SelectionToolbar  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Sticky bulk-selection toolbar shared by the table + gallery views. Generalizes
 * the pattern the /cards grid hand-rolled (select-all-visible + count + Move-to-
 * set) so any entity surface gets the same ergonomics: a slim idle row that
 * swaps to a contrast action panel once something is selected.
 *
 * Selection state is OWNED BY THE CALLER (a `Set<string>` of keys) so it can
 * persist across pages — solving the discovery's "selection clears on
 * pagination" gap. This component is presentation only; it renders:
 *   - a select-all-visible master checkbox (indeterminate aware),
 *   - a live "N selected" / "Select all visible (M)" label,
 *   - an optional "Select all N matching the filter" affordance (for bulk-
 *     grooming a backlog larger than one page),
 *   - a Clear button, and
 *   - the caller's bulk-action buttons (`actions`).
 *
 * Sticky so the action cluster stays reachable while the operator scrolls a
 * long list.
 */
export function SelectionToolbar({
  selectedCount,
  visibleCount,
  allVisibleSelected,
  someVisibleSelected,
  onToggleAllVisible,
  onClear,
  /** Bulk-action buttons shown when a selection exists. */
  actions,
  /** Optional "select all N matching" — total across all pages/filters. */
  matchingTotal,
  onSelectAllMatching,
  /** True while a "select all matching" fetch is in flight. */
  selectAllPending,
  /** Singular/plural noun for the count label. */
  noun = "item",
  className,
}: {
  selectedCount: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  onToggleAllVisible: (next: boolean) => void;
  onClear: () => void;
  actions?: React.ReactNode;
  matchingTotal?: number;
  onSelectAllMatching?: () => void;
  selectAllPending?: boolean;
  noun?: string;
  className?: string;
}) {
  const hasSelection = selectedCount > 0;
  // Offer "select all matching" only when there's more to select than the
  // currently-visible page and the caller wired the handler.
  const canSelectMatching =
    onSelectAllMatching != null &&
    matchingTotal != null &&
    matchingTotal > visibleCount &&
    selectedCount < matchingTotal;

  return (
    <div
      className={cn(
        "sticky top-2 z-20 flex flex-col gap-2 rounded-xl border bg-background/95 px-3 py-2 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between",
        hasSelection && "border-primary/40 bg-primary/[0.04]",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={allVisibleSelected}
            indeterminate={someVisibleSelected}
            onCheckedChange={(v) => onToggleAllVisible(Boolean(v))}
            aria-label={`Select all visible ${noun}s`}
          />
          <span>
            {hasSelection ? (
              <>
                <span className="font-medium text-foreground tabular-nums">
                  {formatNumber(selectedCount)}
                </span>{" "}
                {noun}
                {selectedCount === 1 ? "" : "s"} selected
              </>
            ) : (
              <>Select all visible ({formatNumber(visibleCount)})</>
            )}
          </span>
        </label>

        {canSelectMatching && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSelectAllMatching}
            disabled={selectAllPending}
            className="h-7 px-2 text-xs text-primary hover:text-primary"
          >
            <CheckSquare className="size-3.5" />
            Select all {formatNumber(matchingTotal!)} matching
          </Button>
        )}
      </div>

      {hasSelection && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="h-8 px-2"
          >
            <X className="size-3.5" />
            Clear
          </Button>
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Selection-state hook for an entity surface that needs PERSISTENT,
 * cross-page selection with SHIFT-CLICK range support — the bulk-grooming model
 * /cards needs. The caller passes the currently-visible ordered keys each
 * render; the hook keeps the full selected set (across pages) and the anchor
 * for range selection.
 *
 *   const sel = useEntitySelection(visibleKeys);
 *   <EntityTable selectable selected={sel.selected}
 *     onToggleRow={sel.toggle} onToggleAllVisible={sel.toggleAllVisible} />
 *
 * Returns helpers matching <EntityTable>'s controlled selection props plus the
 * derived header states, so wiring is one-line.
 */
export function useEntitySelection(visibleKeys: string[]) {
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(),
  );
  const anchorRef = React.useRef<string | null>(null);

  const toggle = React.useCallback(
    (key: string, next: boolean, shiftKey: boolean) => {
      setSelected((prev) => {
        const copy = new Set(prev);
        if (shiftKey && anchorRef.current) {
          const a = visibleKeys.indexOf(anchorRef.current);
          const b = visibleKeys.indexOf(key);
          if (a !== -1 && b !== -1) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) {
              if (next) copy.add(visibleKeys[i]);
              else copy.delete(visibleKeys[i]);
            }
          } else {
            if (next) copy.add(key);
            else copy.delete(key);
          }
        } else {
          if (next) copy.add(key);
          else copy.delete(key);
        }
        return copy;
      });
      anchorRef.current = key;
    },
    [visibleKeys],
  );

  const toggleAllVisible = React.useCallback(
    (next: boolean) => {
      setSelected((prev) => {
        const copy = new Set(prev);
        for (const k of visibleKeys) {
          if (next) copy.add(k);
          else copy.delete(k);
        }
        return copy;
      });
    },
    [visibleKeys],
  );

  const selectKeys = React.useCallback((keys: string[]) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      for (const k of keys) copy.add(k);
      return copy;
    });
  }, []);

  const clear = React.useCallback(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));
  const someVisibleSelected =
    !allVisibleSelected && visibleKeys.some((k) => selected.has(k));

  return {
    selected,
    toggle,
    toggleAllVisible,
    selectKeys,
    clear,
    allVisibleSelected,
    someVisibleSelected,
    count: selected.size,
  } as const;
}
