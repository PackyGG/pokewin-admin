"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Loader2, MoreHorizontal, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";

type FilterOption = {
  label: string;
  value: string;
};

// Exact-shape detectors for the search input's instant-fire path (skip
// the debounce when the term already uniquely resolves server-side).
// A full UUID maps to the primary key; a well-formed email maps to the
// unique email index — both are single indexed lookups, so there is no
// benefit to waiting for more keystrokes. Mirrors the UUID / email shape
// routing in src/lib/queries/users-list.ts so "instant" here lines up
// with the server fast paths there.
const EXACT_SEARCH_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT_SEARCH_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function DataTableToolbar({
  searchPlaceholder = "Search...",
  filters,
  children,
  leading,
  searchSlot,
  afterSearch,
}: {
  searchPlaceholder?: string;
  filters?: {
    name: string;
    paramKey: string;
    options: FilterOption[];
    // Optional override for the label shown when no value is selected
    // (the "all" state). Defaults to `All ${name}`. Useful when the
    // filter isn't a category set but a sort / time-window selector
    // (e.g. "Recent" / "All time") where "All Sort" reads weird.
    allLabel?: string;
  }[];
  children?: React.ReactNode;
  /**
   * Optional slot rendered BEFORE the search input. Used for filter
   * primitives that pair with the search box rather than the trailing
   * filter dropdowns — e.g. the Fill / Multiplier tab switch on
   * /creators sits to the left of the search input as a peer.
   *
   * On phones the toolbar stacks vertically, so `leading` drops above
   * the search input; at sm+ it sits inline to the left of the search.
   */
  leading?: React.ReactNode;
  /**
   * Optional override for the built-in search input. When provided, this
   * node is rendered in the search slot INSTEAD of the default
   * `?search=`-param input, and the toolbar's own search state +
   * debounce are inert (a custom search owns the term). Used by /creators
   * to drop in an instant client-side filter (no server round-trip) where
   * the URL-param search would otherwise re-run the page's heavy data
   * fetch on every keystroke. Callers that don't pass it keep the
   * standard debounced URL-param search unchanged.
   */
  searchSlot?: React.ReactNode;
  /**
   * Optional slot rendered immediately AFTER (to the right of) the search
   * input — for a control that pairs directly with the search box rather than
   * the trailing filter dropdowns (e.g. the /users "Affiliate code only"
   * checkbox that changes WHAT the search matches). Defaults to `undefined`,
   * so every existing consumer renders byte-identically. On phones it stacks
   * below the search input (like `leading` stacks above); at sm+ it sits
   * inline to the right of the search.
   */
  afterSearch?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  // Gate the action children to a SINGLE mount location per viewport instead
  // of rendering them twice (an inline `md:contents` copy + a mobile dropdown
  // copy, display-toggled). Mounting the same children twice risked duplicate
  // element ids / event listeners and doubled any child-local state. The hook
  // keys off the same 768px `md` breakpoint the layout classes use, and
  // returns `false` during SSR + first client render so hydration matches the
  // desktop-inline branch (no flash, no mismatch); it flips to the dropdown
  // branch after mount if the viewport is actually <md.
  const isMobile = useIsMobile();
  const [searchValue, setSearchValue] = useState(
    searchParams.get("search") ?? ""
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  const IGNORED_PARAMS = useMemo(() => new Set(["page", "perPage", "sortBy", "sortOrder"]), []);
  const hasActiveFilters = useMemo(
    () => Array.from(searchParams.keys()).some((key) => !IGNORED_PARAMS.has(key)),
    [searchParams, IGNORED_PARAMS]
  );

  function clearFilters() {
    setSearchValue("");
    startTransition(() => router.replace(pathname));
  }

  const updateParam = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParamsRef.current.toString());
    if (value && value !== "all") {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.set("page", "1");
    startTransition(() => router.replace(`?${params.toString()}`));
  }, [router, startTransition]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchValue(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Exact-shape inputs resolve to a single indexed row server-side
      // (UUID = primary key, full email = unique index), so there's no
      // value in waiting out the debounce — every extra keystroke would
      // only change the same already-unique lookup. Fire immediately so
      // pasting an ID / email feels instant. A still-being-typed handle
      // keeps the 300 ms debounce (one server round-trip per pause, not
      // per keystroke). Shape-only check — purely changes WHEN the
      // existing `?search=` update fires, never whether, so it's inert
      // for non-search toolbars.
      const trimmed = value.trim();
      const isExactShape =
        EXACT_SEARCH_UUID_RE.test(trimmed) ||
        EXACT_SEARCH_EMAIL_RE.test(trimmed);
      if (isExactShape) {
        updateParam("search", value);
        return;
      }
      debounceRef.current = setTimeout(() => {
        updateParam("search", value);
      }, 300);
    },
    [updateParam]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    // Mobile-first: search takes the full row, filter pills wrap below.
    // At sm+ everything lines up in one row again.
    <div className="flex flex-col gap-2 pb-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
      {leading && (
        // Leading slot — sits inline to the left of the search at sm+,
        // stacks above on phones. `shrink-0` keeps the pair (tab switch
        // + search) from squeezing the trailing filter buttons.
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {leading}
        </div>
      )}
      {searchSlot ?? (
        <div className="relative w-full sm:flex-1 sm:min-w-[200px] sm:max-w-sm">
          {isPending ? (
            <Loader2 className="absolute left-2.5 top-2.5 size-4 text-muted-foreground animate-spin" />
          ) : (
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          )}
          <Input
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(e) => handleSearchChange(e.target.value)}
            // h-9 aligns the search box with the h-9 filter selects +
            // toolbar buttons so the whole toolbar shares one control height.
            className="h-9 rounded-lg pl-8"
          />
        </div>
      )}
      {afterSearch && (
        // Adornment that pairs with the search input (e.g. the /users
        // "Affiliate code only" checkbox). `shrink-0` keeps it from being
        // squeezed; on phones it stacks below the full-width search, at sm+ it
        // sits inline to the right of it.
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {afterSearch}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 md:contents">
        {filters?.map((filter) => {
          const currentValue = searchParams.get(filter.paramKey) ?? "all";
          const allLabel = filter.allLabel ?? `All ${filter.name}`;
          const currentLabel =
            currentValue === "all"
              ? allLabel
              : filter.options.find((o) => o.value === currentValue)?.label ?? allLabel;
          return (
            <Select
              key={filter.paramKey}
              value={currentValue}
              onValueChange={(v) => updateParam(filter.paramKey, v ?? "all")}
            >
              <SelectTrigger className="w-[150px]">
                <span className="truncate">{currentLabel}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{allLabel}</SelectItem>
                {filter.options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        })}
        {/* Action buttons (children) — inline at md+ where 5+ chips
            comfortably fit one row, collapsed into a single "More" overflow
            menu at <md so the toolbar stays one tidy row on phones instead
            of an unpredictable wrap of 5+ stacked buttons. The children mount
            in exactly ONE place per viewport (inline OR dropdown, chosen by
            `useIsMobile`) — never both — so there are no duplicate ids /
            listeners and no doubled child state. Visually identical to the
            previous display-toggled layout at every breakpoint. */}
        {children && (
          isMobile ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 px-2"
                    aria-label="More actions"
                  />
                }
              >
                <MoreHorizontal className="size-4" />
                <span className="ml-1 text-xs font-medium">More</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="flex w-56 flex-col gap-1 p-2"
              >
                {children}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="contents">{children}</div>
          )
        )}
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9 px-2 lg:px-3">
            Clear
            <X className="ml-1 size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
