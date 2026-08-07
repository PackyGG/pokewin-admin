"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  URL-state hooks  (pokewin-admin · src/lib/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ONE source of truth for the URL-param read/write idiom every operational
 * list page hand-rolls today (DataTableToolbar, PriceFilter, SetFilter,
 * DataTableColumnHeader, …). Centralizing it means:
 *
 *   - State survives navigation, reload and ⌘-click (it lives in the URL, not
 *     transient client state) — the shared `/packs` + `/cards` rebuild can
 *     deep-link any filtered/sorted/paginated view.
 *   - Small actions (toggle a pack active, edit a price in a drawer) don't
 *     reset the page, because they don't touch these params.
 *   - Search is DEBOUNCED so each keystroke doesn't fire a server round-trip.
 *   - Changing a FILTER or the SEARCH term resets `page` to 1 (you can't be on
 *     page 7 of a result set that just shrank); changing the SORT does NOT
 *     reset the page count meaning, but does reset to page 1 too because the
 *     ordering changed what "page 1" is — matching DataTableColumnHeader's
 *     existing behaviour would keep the page, so we keep parity and DO reset
 *     on sort as well (documented per-hook below).
 *
 * Everything writes via `router.replace` inside a `useTransition` (non-blocking
 * — the input stays responsive while the server segment re-renders), exactly
 * like the existing toolbar. Reads come from `useSearchParams`.
 *
 * No new deps: pure Next.js navigation hooks + React. These are client hooks
 * (the file carries "use client"); import them only from Client Components.
 */

// ─── shared writer ──────────────────────────────────────────────────────────

/**
 * Internal: build a writer bound to the live searchParams via a ref so the
 * returned callbacks are stable (don't churn on every param change) yet always
 * read the latest URL. Mirrors DataTableToolbar's `searchParamsRef` trick.
 */
function useParamWriter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = React.useTransition();

  const paramsRef = React.useRef(searchParams);
  paramsRef.current = searchParams;

  /**
   * Apply a batch of param mutations atomically and navigate. `null`/`""`
   * values delete the key. When `resetPage` is true (default) the `page` key
   * is reset to "1" so a narrowed result set doesn't strand the operator on a
   * now-empty page.
   */
  const setParams = React.useCallback(
    (
      updates: Record<string, string | null | undefined>,
      opts?: { resetPage?: boolean; pageKey?: string },
    ) => {
      const resetPage = opts?.resetPage ?? true;
      const pageKey = opts?.pageKey ?? "page";
      const next = new URLSearchParams(paramsRef.current.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (resetPage) next.set(pageKey, "1");
      const qs = next.toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [router, pathname],
  );

  return { setParams, isPending, paramsRef } as const;
}

// ─── useDebouncedSearch ─────────────────────────────────────────────────────

/**
 * Debounced URL-param search box state. Returns the live (immediate) input
 * value plus an `onChange` that updates the input instantly but only writes
 * `?<paramKey>=` after `delayMs` of quiet — so typing doesn't fire a request
 * per keystroke. Resets `page` to 1 on write.
 *
 *   const { value, onChange, isPending } = useDebouncedSearch();
 *   <Input value={value} onChange={(e) => onChange(e.target.value)} />
 */
export function useDebouncedSearch({
  paramKey = "search",
  delayMs = 300,
}: {
  paramKey?: string;
  delayMs?: number;
} = {}) {
  const searchParams = useSearchParams();
  const { setParams, isPending } = useParamWriter();
  const urlValue = searchParams.get(paramKey) ?? "";

  const [value, setValue] = React.useState(urlValue);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the value we last wrote so an external URL change (back button,
  // clear-all) re-syncs the input, but our own debounced writes don't clobber
  // mid-typing.
  const lastWrittenRef = React.useRef(urlValue);

  React.useEffect(() => {
    if (urlValue !== lastWrittenRef.current) {
      lastWrittenRef.current = urlValue;
      setValue(urlValue);
    }
  }, [urlValue]);

  const onChange = React.useCallback(
    (next: string) => {
      setValue(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        lastWrittenRef.current = next;
        setParams({ [paramKey]: next });
      }, delayMs);
    },
    [delayMs, paramKey, setParams],
  );

  // Flush + clear the timer on unmount so a pending write doesn't fire against
  // a stale route, and no dangling timeout leaks.
  React.useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const clear = React.useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    lastWrittenRef.current = "";
    setValue("");
    setParams({ [paramKey]: null });
  }, [paramKey, setParams]);

  return { value, onChange, clear, isPending } as const;
}

// ─── useUrlFilters ──────────────────────────────────────────────────────────

type ActiveFilter = {
  /** The param key this filter writes. */
  key: string;
  /** The raw param value. */
  value: string;
};

/**
 * Read/write a set of URL-param filters. Returns the current value for every
 * key, a setter (writes one key, resets page), a clear-one and a clear-all.
 *
 * `keys` is the list of param keys this surface treats as filters (e.g.
 * `["active", "rarity", "setId", "minPrice", "maxPrice"]`). `reserved` lists
 * params that are NOT filters (pagination / sort / tab) so `activeFilters`
 * and `clearAll` ignore them — matching DataTableToolbar's IGNORED_PARAMS.
 */
export function useUrlFilters({
  keys,
  reserved = ["page", "perPage", "sortBy", "sortOrder"],
}: {
  keys: readonly string[];
  reserved?: readonly string[];
}) {
  const searchParams = useSearchParams();
  const { setParams, isPending } = useParamWriter();

  const get = React.useCallback(
    (key: string): string => searchParams.get(key) ?? "",
    [searchParams],
  );

  const setFilter = React.useCallback(
    (key: string, value: string | null) => {
      setParams({ [key]: value && value !== "all" ? value : null });
    },
    [setParams],
  );

  const setMany = React.useCallback(
    (updates: Record<string, string | null>) => {
      const normalized: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(updates)) {
        normalized[k] = v && v !== "all" ? v : null;
      }
      setParams(normalized);
    },
    [setParams],
  );

  const clearFilter = React.useCallback(
    (key: string) => setParams({ [key]: null }),
    [setParams],
  );

  // Every currently-set param that is a known filter key (in declaration
  // order) — drives the always-visible active-filter chips in <FilterBar>.
  const activeFilters: ActiveFilter[] = React.useMemo(() => {
    const out: ActiveFilter[] = [];
    for (const key of keys) {
      const value = searchParams.get(key);
      if (value != null && value !== "" && value !== "all") {
        out.push({ key, value });
      }
    }
    return out;
  }, [keys, searchParams]);

  const reservedSet = React.useMemo(() => new Set(reserved), [reserved]);
  const hasAnyActive = React.useMemo(
    () =>
      Array.from(searchParams.keys()).some((k) => !reservedSet.has(k)),
    [searchParams, reservedSet],
  );

  // Clear every non-reserved param at once (keeps pagination/sort/tab intact
  // when those are listed in `reserved`). Resets page to 1.
  const clearAll = React.useCallback(() => {
    const updates: Record<string, null> = {};
    for (const k of Array.from(searchParams.keys())) {
      if (!reservedSet.has(k)) updates[k] = null;
    }
    setParams(updates);
  }, [searchParams, reservedSet, setParams]);

  return {
    get,
    setFilter,
    setMany,
    clearFilter,
    clearAll,
    activeFilters,
    hasAnyActive,
    isPending,
  } as const;
}

// ─── useUrlSort ─────────────────────────────────────────────────────────────

export type SortOrder = "asc" | "desc";

/**
 * Read/toggle the `sortBy` / `sortOrder` URL params used by the existing
 * DataTableColumnHeader + every list query (`getPacks`, `getCards`). Clicking
 * the active column flips the direction; clicking a new column sorts it
 * ascending. Resets to page 1 (the ordering changed what page 1 means).
 */
export function useUrlSort({
  sortByKey = "sortBy",
  sortOrderKey = "sortOrder",
  defaultOrder = "desc",
}: {
  sortByKey?: string;
  sortOrderKey?: string;
  defaultOrder?: SortOrder;
} = {}) {
  const searchParams = useSearchParams();
  const { setParams, isPending } = useParamWriter();

  const sortBy = searchParams.get(sortByKey);
  const sortOrder: SortOrder =
    searchParams.get(sortOrderKey) === "asc"
      ? "asc"
      : searchParams.get(sortOrderKey) === "desc"
        ? "desc"
        : defaultOrder;

  const toggleSort = React.useCallback(
    (key: string) => {
      const isActive = sortBy === key;
      const nextOrder: SortOrder =
        isActive && sortOrder === "asc" ? "desc" : "asc";
      setParams({ [sortByKey]: key, [sortOrderKey]: nextOrder });
    },
    [sortBy, sortOrder, sortByKey, sortOrderKey, setParams],
  );

  const setSort = React.useCallback(
    (key: string, order: SortOrder) => {
      setParams({ [sortByKey]: key, [sortOrderKey]: order });
    },
    [sortByKey, sortOrderKey, setParams],
  );

  return { sortBy, sortOrder, toggleSort, setSort, isPending } as const;
}

// ─── useUrlPagination ───────────────────────────────────────────────────────

/**
 * Read/write the `page` / `perPage` URL params. Page changes do NOT reset
 * anything else; changing `perPage` snaps back to page 1 (the offset no longer
 * lines up). Bounded by `totalPages` so the caller can disable nav buttons.
 */
function useUrlPagination({
  pageKey = "page",
  perPageKey = "perPage",
}: {
  pageKey?: string;
  perPageKey?: string;
} = {}) {
  const searchParams = useSearchParams();
  const { setParams, isPending } = useParamWriter();

  const page = Math.max(1, Number(searchParams.get(pageKey)) || 1);
  const perPage = Number(searchParams.get(perPageKey)) || 0;

  const setPage = React.useCallback(
    (next: number) => {
      // Page nav must not reset itself — pass resetPage:false and write page
      // directly.
      setParams({ [pageKey]: String(Math.max(1, next)) }, { resetPage: false });
    },
    [pageKey, setParams],
  );

  const setPerPage = React.useCallback(
    (next: number) => {
      // Changing rows-per-page resets to page 1 via the default resetPage.
      setParams({ [perPageKey]: String(next) }, { pageKey });
    },
    [perPageKey, pageKey, setParams],
  );

  return { page, perPage, setPage, setPerPage, isPending } as const;
}

// ─── useUrlParam ────────────────────────────────────────────────────────────

/**
 * Generic single-param read/write for view toggles (`?view=grid|table`),
 * inspector targets (`?inspect=<id>`), sub-tabs, etc. `resetPage` defaults to
 * FALSE here — a view toggle or opening an inspector should not reset the
 * list's page. Pass `resetPage: true` for params that genuinely change the
 * result set.
 */
export function useUrlParam(
  key: string,
  {
    defaultValue = "",
    resetPage = false,
  }: { defaultValue?: string; resetPage?: boolean } = {},
) {
  const searchParams = useSearchParams();
  const { setParams, isPending } = useParamWriter();

  const value = searchParams.get(key) ?? defaultValue;

  const setValue = React.useCallback(
    (next: string | null) => {
      setParams({ [key]: next }, { resetPage });
    },
    [key, resetPage, setParams],
  );

  return [value, setValue, isPending] as const;
}
