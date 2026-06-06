"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  COMPARE_MAX,
  COMPARE_MIN,
  formatCompareParam,
} from "../_lib/compare-params";
import type { ComparePickerCreator } from "../_queries/compare-creators";
import { matchesRosterSearch } from "../../creators/_components/roster-search-context";

/**
 * Compare picker — multi-select (2–3) with instant creator search.
 * Selection syncs to `?compare=id1,id2` via router.replace (no scroll).
 */
export function ComparePicker({
  creators,
  selectedIds,
}: {
  creators: ComparePickerCreator[];
  selectedIds: string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selectedSet = React.useMemo(
    () => new Set(selectedIds),
    [selectedIds],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim();
    if (!q) return creators.slice(0, 12);
    return creators
      .filter((c) => matchesRosterSearch(c, q))
      .slice(0, 12);
  }, [creators, query]);

  function syncIds(next: string[]) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.length === 0) params.delete("compare");
    else params.set("compare", formatCompareParam(next));
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

  function addId(id: string) {
    if (selectedSet.has(id) || selectedIds.length >= COMPARE_MAX) return;
    syncIds([...selectedIds, id]);
    setQuery("");
    setOpen(false);
  }

  function removeId(id: string) {
    syncIds(selectedIds.filter((x) => x !== id));
  }

  const selectedCreators = selectedIds
    .map((id) => creators.find((c) => c.id === id))
    .filter(Boolean) as ComparePickerCreator[];

  const atMax = selectedIds.length >= COMPARE_MAX;
  const canCompare = selectedIds.length >= COMPARE_MIN;

  return (
    <div className="space-y-3">
      {/* Selected chips */}
      <div className="flex flex-wrap items-center gap-2">
        {selectedCreators.map((c) => (
          <Badge
            key={c.id}
            variant="secondary"
            className="gap-1.5 py-1 pl-1 pr-1.5 text-xs font-medium"
          >
            <Avatar className="size-5">
              {c.image && <AvatarImage src={c.image} alt="" />}
              <AvatarFallback className="bg-pink-500/15 text-[9px] font-semibold text-pink-700 dark:text-pink-300">
                {initials(c.username)}
              </AvatarFallback>
            </Avatar>
            <span className="max-w-[120px] truncate">
              {c.username ?? "Unknown"}
            </span>
            <button
              type="button"
              onClick={() => removeId(c.id)}
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Remove ${c.username ?? "creator"}`}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {selectedIds.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Pick {COMPARE_MIN}–{COMPARE_MAX} creators to compare
          </p>
        )}
        {selectedIds.length === 1 && (
          <p className="text-xs text-muted-foreground">
            Add one more creator to start comparing
          </p>
        )}
        {canCompare && (
          <span className="text-[11px] text-muted-foreground">
            {selectedIds.length} of {COMPARE_MAX} selected
          </span>
        )}
      </div>

      {/* Search + add */}
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so mousedown on a result registers before close.
            window.setTimeout(() => setOpen(false), 150);
          }}
          placeholder={
            atMax
              ? "Maximum creators selected"
              : "Search by username, email, or code..."
          }
          disabled={atMax}
          className="h-9 pl-9"
          aria-label="Search creators to compare"
          aria-expanded={open}
          aria-haspopup="listbox"
        />
        {open && !atMax && filtered.length > 0 && (
          <ul
            role="listbox"
            className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border bg-popover py-1 shadow-md"
          >
            {filtered.map((c) => {
              const picked = selectedSet.has(c.id);
              return (
                <li key={c.id} role="option" aria-selected={picked}>
                  <button
                    type="button"
                    disabled={picked}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => addId(c.id)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
                      picked
                        ? "cursor-not-allowed opacity-50"
                        : "hover:bg-accent",
                    )}
                  >
                    <Avatar className="size-7 shrink-0">
                      {c.image && <AvatarImage src={c.image} alt="" />}
                      <AvatarFallback className="bg-pink-500/15 text-[10px] font-semibold text-pink-700 dark:text-pink-300">
                        {initials(c.username)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {c.username ?? "Unknown"}
                      </p>
                      {c.code && (
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {c.code}
                        </p>
                      )}
                    </div>
                    {picked && (
                      <span className="text-[10px] text-muted-foreground">
                        Added
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {open && !atMax && query.trim() && filtered.length === 0 && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md">
            No creators match &ldquo;{query.trim()}&rdquo;
          </div>
        )}
      </div>

      {selectedIds.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-xs text-muted-foreground"
          onClick={() => syncIds([])}
        >
          Clear selection
        </Button>
      )}
    </div>
  );
}

function initials(name: string | null): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  return clean.slice(0, 2).toUpperCase();
}
