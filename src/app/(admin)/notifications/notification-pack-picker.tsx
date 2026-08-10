"use client";

import { useDeferredValue, useEffect, useState, useTransition } from "react";
import { ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils/format";
import {
  searchAnnouncementPacks,
  searchDirectNotificationPacks,
  type AnnouncementPackOption,
} from "./composer-actions";

export function NotificationPackPicker({
  value,
  onSelect,
  scope,
  disabled = false,
}: {
  value: AnnouncementPackOption | null;
  onSelect: (pack: AnnouncementPackOption) => void;
  scope: "announcement" | "direct";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [items, setItems] = useState<AnnouncementPackOption[]>([]);
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let current = true;
    startTransition(async () => {
      try {
        const search =
          scope === "announcement"
            ? searchAnnouncementPacks
            : searchDirectNotificationPacks;
        const next = await search(deferredQuery);
        if (current) {
          setItems(next);
          setFailed(false);
        }
      } catch {
        if (current) {
          setItems([]);
          setFailed(true);
        }
      }
    });
    return () => {
      current = false;
    };
  }, [deferredQuery, open, scope]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="h-9 w-full justify-between text-left font-normal"
            disabled={disabled}
          />
        }
      >
        {value ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {value.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={value.imageUrl}
                alt=""
                className="size-5 shrink-0 rounded object-contain"
              />
            )}
            <span className="truncate">{value.name}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {formatCurrency(value.priceUsd)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">Select pack…</span>
        )}
        <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search active packs…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {isPending && items.length === 0 && (
              <div className="space-y-1 p-1" aria-hidden>
                {Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={index}
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
              <CommandEmpty>
                {failed ? "Couldn’t load packs." : "No active packs found."}
              </CommandEmpty>
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
                    <img
                      src={item.imageUrl}
                      alt=""
                      className="size-8 rounded object-contain"
                    />
                  ) : (
                    <div className="flex size-8 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                      N/A
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{item.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {formatCurrency(item.priceUsd)} · /{item.slug}
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
