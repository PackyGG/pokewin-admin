"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";

/**
 * Canonical filter chrome for admin list pages.
 *
 * Two flavours, same look-and-feel — pick the one that matches HOW the
 * page filters its data:
 *
 *   • {@link FilterToolbar}  —  URL-driven filtering (the common case).
 *     Server reads `?status=…&search=…&minValue=…` etc. from the page's
 *     `searchParams` and re-runs the query. This is a thin re-export of
 *     {@link DataTableToolbar} so every existing surface keeps working —
 *     /transactions, /vouchers, /gift-cards, /promo-codes, /withdrawals,
 *     etc. all already use this primitive.
 *
 *   • {@link FilterToolbarShell}  —  in-memory client filtering. Used
 *     when the page renders a small, fully-loaded list (e.g. the admin
 *     balance-caps overview) and filters it client-side via local state.
 *     Provides the same flex / wrap / gap layout the URL toolbar uses,
 *     plus an optional {@link FilterToolbarSearch} sub-primitive for the
 *     "search input with leading icon" pattern.
 *
 * Both render into a `flex-col gap-2 pb-4 sm:flex-row sm:flex-wrap
 * sm:items-center sm:gap-3` shell so the search input, filter pills, and
 * actions wrap consistently across the admin and stay touch-friendly on
 * phones. No new dependencies — purely composition over the existing
 * shadcn primitives.
 *
 * Why not collapse into one component? Two reasons:
 *   1. URL vs in-memory filtering have very different state-management
 *      shapes (router.replace + URLSearchParams vs useState). A single
 *      config-driven API would be a foot-gun for both.
 *   2. The URL toolbar already exists, is battle-tested, and is the
 *      shape every existing surface uses. Renaming it would touch every
 *      data-table file for no value — re-exporting it gives a single
 *      canonical entry-point without churn.
 *
 * EmptyState lives next door: `@/components/empty-state`. Use it for
 * the "no rows match" state inside the table body — see e.g.
 * /transactions/data-table.tsx for the standard pattern.
 */

// ---------------------------------------------------------------------------
// URL-driven filter toolbar (the common case)
// ---------------------------------------------------------------------------

/**
 * URL-driven filter toolbar — re-export of the existing
 * {@link DataTableToolbar}. Use this on any list page where the server
 * reads filters from `searchParams` and re-runs its query.
 *
 * Slots:
 *   - `searchPlaceholder` — placeholder for the built-in `?search=` input.
 *   - `filters` — array of `{ name, paramKey, options, allLabel? }` for
 *     dropdown filters that bind to a URL param.
 *   - `leading` — node rendered BEFORE the search input (e.g. a tab pill
 *     row that pairs with the search box).
 *   - `searchSlot` — replaces the built-in search input entirely (for
 *     client-side instant search that owns the term).
 *   - `children` — node rendered AFTER the filter dropdowns (e.g. a
 *     value-range filter, a bulk-select toggle).
 *
 * The toolbar handles 300 ms debouncing of the search input, exact-shape
 * fast-paths for full UUID / email input (fires immediately, no debounce),
 * a "Clear" button that appears when any non-pagination filter is set, and
 * resets `page` to 1 on every filter change.
 */
export const FilterToolbar = DataTableToolbar;

// ---------------------------------------------------------------------------
// Client-side filter shell (for in-memory filtering)
// ---------------------------------------------------------------------------

/**
 * Slot-based filter toolbar shell for client-side filtering. Use this on
 * pages where the rows are already loaded and the filter is a local
 * `useState` (e.g. balance-caps overview). Just renders the consistent
 * flex / wrap / gap chrome so the search + actions row looks identical
 * to the URL-driven {@link FilterToolbar}.
 *
 * Compose with {@link FilterToolbarSearch} for the standard search-input
 * look, or pass any nodes as `children` / `actions`.
 *
 *   <FilterToolbarShell
 *     actions={<AddSomethingButton />}
 *   >
 *     <FilterToolbarSearch
 *       value={query}
 *       onChange={setQuery}
 *       placeholder="Filter by name…"
 *     />
 *   </FilterToolbarShell>
 *
 * Why a shell and not a config-monster? Client-side filters are tiny and
 * idiosyncratic — one page filters by name, another by status, a third by
 * date. Composition stays out of the way; the shell only owns the layout.
 */
export function FilterToolbarShell({
  children,
  actions,
  className,
}: {
  /** Primary controls: search input, status chips, etc. */
  children?: React.ReactNode;
  /** Trailing slot for buttons (e.g. "Add limit"). Pushed to the right at sm+. */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Same shell as DataTableToolbar — keeps the visual rhythm consistent
        // whether the page filters via URL or in-memory. Mobile-first: stack
        // vertically, then sm+ goes inline with wrap.
        "flex flex-col gap-2 pb-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3",
        className,
      )}
    >
      {children}
      {actions && (
        // Push actions to the right at sm+ so the "Add" button sits opposite
        // the search input, matching the legacy hand-rolled layout. On phones
        // they stack below at full width.
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {actions}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search input sub-primitive
// ---------------------------------------------------------------------------

/**
 * Standard search input with leading magnifier icon — matches the shape
 * of the built-in search in {@link FilterToolbar} so a client-side
 * filter on one page looks the same as a server-driven filter on the
 * next. Controlled component; the caller owns the term.
 */
export function FilterToolbarSearch({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Width mirrors the URL toolbar's search input: full row on
        // phones, flex with a min/max at sm+ so the trailing actions
        // get the remaining space.
        "relative w-full sm:flex-1 sm:min-w-[200px] sm:max-w-sm",
        className,
      )}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-9"
      />
    </div>
  );
}
