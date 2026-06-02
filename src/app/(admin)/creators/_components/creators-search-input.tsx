"use client";

import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { useCreatorsSearch } from "./creators-search-context";

/**
 * Instant username/email search for /creators.
 *
 * Filters the already-loaded roster CLIENT-SIDE via <CreatorsSearchProvider>
 * — every keystroke narrows the rendered cards in place with no navigation,
 * no server round-trip, and no Suspense skeleton. Replaces the old
 * URL-param search in <DataTableToolbar>, which re-ran the page's heavy
 * server fetch (roster-wide GGR ledger scan + backend roster walk) on every
 * keystroke. See creators-search-context.tsx for the full rationale.
 *
 * Visual parity with the <DataTableToolbar> search input it replaces (same
 * width clamp, leading search icon, `pl-8`) so the toolbar layout is
 * unchanged. Adds a clear button + Esc-to-clear for keyboard-friendly
 * reset. No spinner — filtering is synchronous, so a loading indicator
 * would never actually show.
 *
 * Client-safe: imports only the Input primitive, lucide icons, `cn`, and
 * the search context — no server query-module value imports.
 */
export function CreatorsSearchInput({
  placeholder = "Search by username or email...",
}: {
  placeholder?: string;
}) {
  const { query, setQuery } = useCreatorsSearch();
  const hasValue = query.length > 0;

  return (
    <div className="relative w-full sm:flex-1 sm:min-w-[200px] sm:max-w-sm">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && hasValue) {
            e.preventDefault();
            setQuery("");
          }
        }}
        placeholder={placeholder}
        aria-label="Search creators by username or email"
        // `pr-8` reserves room for the clear button so long queries don't
        // slide under it. Hide the native search-cancel "X" (WebKit) — we
        // render our own consistent one below.
        className={cn(
          "pl-8 [&::-webkit-search-cancel-button]:appearance-none",
          hasValue && "pr-8",
        )}
      />
      {hasValue && (
        <button
          type="button"
          onClick={() => setQuery("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
