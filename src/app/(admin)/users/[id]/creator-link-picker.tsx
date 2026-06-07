"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronsUpDown, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  searchCreatorsForLink,
  type CreatorLinkOption,
} from "@/app/(admin)/creators/_queries/search-creators-for-link";

const DEBOUNCE_MS = 250;

function creatorLabel(c: CreatorLinkOption): string {
  return c.username ?? c.email ?? c.id.slice(0, 8);
}

/**
 * Searchable creator picker — a Popover + cmdk Command with the search
 * input pinned at the top (the "small search at the top" the spec asks
 * for). Reuses the canonical creator list via the `searchCreatorsForLink`
 * server action (which wraps the owner-authoritative `creatorsApi.list`),
 * with the same debounce + out-of-order-response guard the "Add Creator"
 * dialog uses. `shouldFilter={false}` because the backend already filters
 * by the search term — we never filter the streamed results client-side.
 *
 * Controlled: the parent owns the selected `{ id, label }` so it can
 * validate "a creator is linked" before submit. House UI, dark-mode.
 */
export function CreatorLinkPicker({
  value,
  onSelect,
  disabled,
}: {
  value: { id: string; label: string } | null;
  onSelect: (creator: { id: string; label: string } | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CreatorLinkOption[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [, startTransition] = useTransition();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  // Fetch on open + whenever the query changes (debounced). An empty query
  // loads the first page of creators so the list is useful immediately.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    setIsSearching(true);
    const reqId = ++requestIdRef.current;
    debounceRef.current = setTimeout(() => {
      startTransition(async () => {
        try {
          const found = await searchCreatorsForLink(query.trim());
          // Guard against out-of-order responses.
          if (reqId === requestIdRef.current) setItems(found);
        } catch {
          if (reqId === requestIdRef.current) setItems([]);
        } finally {
          if (reqId === requestIdRef.current) setIsSearching(false);
        }
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-9 w-full justify-between text-left font-normal"
          />
        }
      >
        {value ? (
          <span className="flex items-center gap-2 truncate">
            <Sparkles className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">{value.label}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Select a creator...</span>
        )}
        <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search creators..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {isSearching && items.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Searching...
              </div>
            ) : items.length === 0 ? (
              <CommandEmpty>No creators found.</CommandEmpty>
            ) : (
              items.map((c) => {
                const label = creatorLabel(c);
                return (
                  <CommandItem
                    key={c.id}
                    value={c.id}
                    onSelect={() => {
                      onSelect({ id: c.id, label });
                      setOpen(false);
                    }}
                  >
                    <div className="flex w-full items-center gap-2">
                      {c.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={c.image}
                          alt=""
                          className="size-7 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex size-7 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                          {label.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 truncate text-sm">
                          <span className="truncate">{label}</span>
                          {c.isExCreator ? (
                            <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/15 px-1 text-[9px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                              Past
                            </span>
                          ) : null}
                        </div>
                        {c.username && c.email ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {c.email}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </CommandItem>
                );
              })
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
