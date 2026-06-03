"use client";

import * as React from "react";
import { Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  useDebouncedSearch,
  useUrlFilters,
} from "@/lib/entity-surface/use-url-state";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  FilterBar  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Shared, URL-driven filter bar for operational list surfaces. Improves on the
 * existing DataTableToolbar in the ways the discovery flagged:
 *
 *   - GROUPED, ALWAYS-VISIBLE ACTIVE FILTERS: below the controls row, every
 *     currently-applied filter renders as a labelled chip with its own ✕ — so
 *     the operator can always see (and individually drop) what's narrowing the
 *     list, instead of a single opaque "Clear" button. A "Clear all" appears
 *     when anything is active.
 *   - DEBOUNCED SEARCH driven by the shared hook (no request per keystroke).
 *   - Declarative `filters` spec (select dropdowns) + a `customControls` slot
 *     for bespoke inputs (price range, set picker) and a `leading` slot for a
 *     peer tab-switch — same extension points the toolbar exposed, so existing
 *     filter primitives drop in unchanged.
 *
 * All state is URL params; nothing here holds server-derived data, so it's a
 * thin client shell over `useUrlFilters` + `useDebouncedSearch`.
 */

export type FilterSelectSpec = {
  /** URL param key this select writes. */
  paramKey: string;
  /** Human label (used for the trigger's "all" state and the active chip). */
  label: string;
  options: { label: string; value: string }[];
  /** Override the "no selection" trigger label (defaults to `All ${label}`). */
  allLabel?: string;
  /** Trigger width (CSS length). Defaults to a compact 150px. */
  width?: string;
};

export type FilterBarProps = {
  /** Search input. Omit to hide it. */
  search?: {
    paramKey?: string;
    placeholder?: string;
    delayMs?: number;
  };
  /** Declarative select-dropdown filters. */
  filters?: FilterSelectSpec[];
  /**
   * Every param key this surface treats as a filter (for the active-chip row +
   * clear-all). Include the select keys AND any custom-control keys (price,
   * setId, …) so they show as chips and get cleared. Order = chip order.
   */
  filterKeys: readonly string[];
  /** Params that are NOT filters (pagination/sort/tab/view). */
  reservedKeys?: readonly string[];
  /**
   * Map a `{ key, value }` active filter to its human chip label. Lets the
   * caller resolve an opaque id (e.g. a set UUID) to a name, or format a price.
   * Falls back to "key: value" when omitted / returns undefined.
   */
  renderChipLabel?: (key: string, value: string) => React.ReactNode | undefined;
  /** Bespoke control nodes (price range, set picker) rendered in the row. */
  customControls?: React.ReactNode;
  /** Node rendered before the search input (e.g. a peer tab-switch). */
  leading?: React.ReactNode;
  /** Node rendered at the trailing edge (e.g. a view toggle). */
  trailing?: React.ReactNode;
  className?: string;
};

export function FilterBar({
  search,
  filters,
  filterKeys,
  reservedKeys,
  renderChipLabel,
  customControls,
  leading,
  trailing,
  className,
}: FilterBarProps) {
  const {
    get,
    setFilter,
    clearFilter,
    clearAll,
    activeFilters,
    hasAnyActive,
    isPending: filtersPending,
  } = useUrlFilters({
    keys: filterKeys,
    ...(reservedKeys ? { reserved: reservedKeys } : {}),
  });

  return (
    <div className={cn("space-y-2", className)}>
      {/* ── Controls row ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        {leading && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {leading}
          </div>
        )}

        {search && <SearchControl {...search} />}

        <div className="flex flex-wrap items-center gap-2 sm:contents">
          {filters?.map((f) => {
            const current = get(f.paramKey) || "all";
            const allLabel = f.allLabel ?? `All ${f.label}`;
            const currentLabel =
              current === "all"
                ? allLabel
                : (f.options.find((o) => o.value === current)?.label ??
                  allLabel);
            return (
              <Select
                key={f.paramKey}
                value={current}
                onValueChange={(v) => setFilter(f.paramKey, v ?? "all")}
              >
                <SelectTrigger style={{ width: f.width ?? "150px" }}>
                  <span className="truncate">{currentLabel}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{allLabel}</SelectItem>
                  {f.options.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          })}
          {customControls}
        </div>

        {trailing && (
          <div className="flex items-center gap-2 sm:ml-auto">{trailing}</div>
        )}
      </div>

      {/* ── Active-filter chips ──────────────────────────────────────────
          Always visible while any filter is applied, so the operator can see
          and drop each one individually. */}
      {hasAnyActive && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <SlidersHorizontal className="size-3" />
            Filters
          </span>
          {activeFilters.map(({ key, value }) => {
            const label = renderChipLabel?.(key, value) ?? `${key}: ${value}`;
            return (
              <Badge
                key={key}
                variant="outline"
                className="h-6 gap-1 border-primary/30 bg-primary/[0.06] pr-1 pl-2 text-xs font-medium text-foreground"
              >
                <span className="truncate max-w-[180px]">{label}</span>
                <button
                  type="button"
                  onClick={() => clearFilter(key)}
                  aria-label={`Remove ${key} filter`}
                  className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            disabled={filtersPending}
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Search control ─────────────────────────────────────────────────────────

function SearchControl({
  paramKey = "search",
  placeholder = "Search…",
  delayMs = 300,
}: {
  paramKey?: string;
  placeholder?: string;
  delayMs?: number;
}) {
  const { value, onChange, isPending } = useDebouncedSearch({
    paramKey,
    delayMs,
  });
  return (
    <div className="relative w-full sm:max-w-sm sm:min-w-[200px] sm:flex-1">
      {isPending ? (
        <Loader2 className="absolute top-2.5 left-2.5 size-4 animate-spin text-muted-foreground" />
      ) : (
        <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
      )}
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-8"
      />
    </div>
  );
}
