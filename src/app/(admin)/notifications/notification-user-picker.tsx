"use client";

import { useEffect, useState, useTransition } from "react";
import { ChevronsUpDown, UserSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
  searchNotificationUsers,
  type NotificationUserOption,
} from "./direct-actions";

/**
 * Recipient search — same shape as the announcement composer's Pack/Promo
 * pickers (Popover + cmdk, `shouldFilter={false}` because the server already
 * filtered). Backed by the bounded username / email / exact-id lookup in
 * `direct-actions`.
 *
 * The bulk form uses it to append ids to the recipient list, so `onSelect`
 * gets the whole option rather than just an id.
 */
export function NotificationUserPicker({
  label = "Find a user…",
  disabled,
  onSelect,
}: {
  label?: string;
  disabled?: boolean;
  onSelect: (user: NotificationUserOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<NotificationUserOption[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    startTransition(async () => {
      setItems(await searchNotificationUsers(query));
    });
  }, [open, query]);

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
        <span className="flex items-center gap-2 truncate text-muted-foreground">
          <UserSearch className="size-3.5 shrink-0" />
          {label}
        </span>
        <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Username, email or exact id…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {isPending && items.length === 0 && (
              <div className="space-y-1 p-1" aria-hidden>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="space-y-1.5 px-2 py-1.5">
                    <Skeleton className="h-3.5 w-1/2 rounded" />
                    <Skeleton className="h-3 w-2/3 rounded" />
                  </div>
                ))}
              </div>
            )}
            {!isPending && items.length === 0 && (
              <CommandEmpty>
                {query.trim().length < 2
                  ? "Type at least 2 characters."
                  : "No users found."}
              </CommandEmpty>
            )}
            {items.map((item) => (
              <CommandItem
                key={item.id}
                value={item.id}
                onSelect={() => {
                  onSelect(item);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <div className="w-full truncate">
                  <div className="truncate text-sm">
                    {item.username ?? item.email ?? item.id}
                  </div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {item.id}
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
