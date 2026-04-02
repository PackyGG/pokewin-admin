"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export function SetFilter({ sets }: { sets: { id: string; name: string }[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const currentSetId = searchParams.get("setId") ?? "";
  const currentLabel = currentSetId
    ? sets.find((s) => s.id === currentSetId)?.name ?? "Unknown set"
    : "All Sets";

  function select(setId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (setId) {
      params.set("setId", setId);
    } else {
      params.delete("setId");
    }
    params.set("page", "1");
    router.replace(`?${params.toString()}`);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="outline" className="w-[180px] justify-between font-normal" />}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronsUpDown className="ml-1 size-3.5 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[250px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search sets..." />
          <CommandList>
            <CommandEmpty>No set found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="all"
                onSelect={() => select("")}
                data-checked={!currentSetId}
              >
                All Sets
              </CommandItem>
              {sets.map((s) => (
                <CommandItem
                  key={s.id}
                  value={s.name}
                  onSelect={() => select(s.id)}
                  data-checked={currentSetId === s.id}
                >
                  {s.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
