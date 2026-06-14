"use client";

import { useEffect, useState, useTransition } from "react";
import { ChevronsUpDown } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils/format";
import { searchItems, type SearchItem } from "./actions";
import {
  formatDropChancePercent,
  formatExpectedOpenings,
} from "./challenge-card-math";

/**
 * Pack/card search-and-select used by the create-challenge form to resolve a
 * pack_id / card_id by name instead of raw uuid entry. Reads packs/cards from
 * the MAIN game DB via the `searchItems` server action (a read, which is
 * allowed). Mirrors the raffles `PrizePicker` shape, minus the price filter.
 */
export function ItemPicker({
  type,
  value,
  onSelect,
  packId,
  disabled = false,
  placeholder,
}: {
  type: "pack" | "card";
  value: { id: string; name?: string; imageUrl?: string | null; priceUsd?: number } | null;
  onSelect: (item: SearchItem) => void;
  /** Card picker only: restrict results to the cards inside this pack's pool. */
  packId?: string;
  /** Disable the trigger (e.g. a card picker before its pack is chosen). */
  disabled?: boolean;
  /** Override the trigger's empty-state label. */
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    startTransition(async () => {
      const results = await searchItems(query, type, { packId });
      setItems(results);
    });
  }, [open, query, type, packId]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="outline"
            disabled={disabled}
            className="h-9 w-full justify-between text-left font-normal"
          />
        }
      >
        {value?.name ? (
          <span className="flex items-center gap-2 truncate">
            {value.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={value.imageUrl} alt="" className="size-5 rounded object-contain" />
            )}
            <span className="truncate">{value.name}</span>
            {value.priceUsd != null && (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {formatCurrency(value.priceUsd)}
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">{placeholder ?? `Select ${type}...`}</span>
        )}
        <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`Search ${type}s...`}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {isPending && items.length === 0 && (
              <div className="space-y-1 p-1" aria-hidden>
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-sm px-2 py-1.5">
                    <Skeleton className="size-8 shrink-0 rounded" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-2/3 rounded" />
                      <Skeleton className="h-3 w-16 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!isPending && items.length === 0 && (
              <CommandEmpty>No {type}s found.</CommandEmpty>
            )}
            {items.map((item) => (
              <CommandItem
                key={item.id}
                value={item.id}
                onSelect={() => {
                  onSelect(item);
                  setOpen(false);
                }}
              >
                <div className="flex w-full items-center gap-2">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" className="size-8 rounded object-contain" />
                  ) : (
                    <div className="flex size-8 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                      N/A
                    </div>
                  )}
                  <div className="flex-1 truncate">
                    <div className="truncate text-sm">{item.name}</div>
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>{formatCurrency(item.priceUsd)}</span>
                      {type === "card" && item.probabilityPercent != null && (
                        <>
                          <span aria-hidden>·</span>
                          <span>{formatDropChancePercent(item.probabilityPercent)}</span>
                          <span aria-hidden>·</span>
                          <span>
                            ~{formatExpectedOpenings(item.expectedOpenings ?? null)} opens
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
