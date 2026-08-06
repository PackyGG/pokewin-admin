"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronsUpDown, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { searchItems, type SearchItem } from "./prize-search-actions";

const DEBOUNCE_MS = 250;

export function PrizePicker({
  type,
  value,
  onSelect,
  placeholder,
  icon: Icon,
}: {
  type: "pack" | "card";
  value: { id: string; name?: string; imageUrl?: string | null; priceUsd?: number } | null;
  onSelect: (item: SearchItem) => void;
  placeholder?: string;
  icon?: LucideIcon;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [isPending, setIsPending] = useState(false);
  const [, startTransition] = useTransition();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  // Debounced + out-of-order-guarded, mirroring `CreatorLinkPicker`. This one
  // re-fired on every `minPrice`/`maxPrice` digit as well as every search
  // keystroke, so a single typed price range queued several leading-wildcard
  // scans whose responses could land out of order. No min-length gate: an
  // empty query is a meaningful "browse" request for this picker.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    setIsPending(true);
    const reqId = ++requestIdRef.current;
    debounceRef.current = setTimeout(() => {
      startTransition(async () => {
        try {
          const results = await searchItems(query, type, {
            minPrice: minPrice ? parseFloat(minPrice) : undefined,
            maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
          });
          if (reqId === requestIdRef.current) setItems(results);
        } catch {
          if (reqId === requestIdRef.current) setItems([]);
        } finally {
          if (reqId === requestIdRef.current) setIsPending(false);
        }
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, query, type, minPrice, maxPrice]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" className="h-9 w-full justify-between text-left font-normal" />
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
        {Icon ? <Icon className="ml-1 size-3 shrink-0 opacity-50" /> : <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />}
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`Search ${type}s...`}
            value={query}
            onValueChange={setQuery}
          />
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Label className="shrink-0 text-xs text-muted-foreground">Price</Label>
            <Input
              type="number"
              placeholder="Min"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              className="h-7 text-xs"
              min={0}
              step="0.01"
            />
            <span className="text-xs text-muted-foreground">-</span>
            <Input
              type="number"
              placeholder="Max"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              className="h-7 text-xs"
              min={0}
              step="0.01"
            />
          </div>
          <CommandList>
            {isPending && items.length === 0 && (
              <div className="space-y-1 p-1" aria-hidden>
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-sm px-2 py-1.5"
                  >
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
                    <div className="text-xs text-muted-foreground">{formatCurrency(item.priceUsd)}</div>
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
