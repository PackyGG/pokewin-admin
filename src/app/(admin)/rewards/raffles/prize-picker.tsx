"use client";

import { useEffect, useState, useTransition } from "react";
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
import { formatCurrency } from "@/lib/utils/format";
import { searchItems, type SearchItem } from "./actions";

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
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    startTransition(async () => {
      const results = await searchItems(query, type, {
        minPrice: minPrice ? parseFloat(minPrice) : undefined,
        maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      });
      setItems(results);
    });
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
