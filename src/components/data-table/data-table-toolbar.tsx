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
import { Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type FilterOption = {
  label: string;
  value: string;
};

export function DataTableToolbar({
  searchPlaceholder = "Search...",
  filters,
  children,
}: {
  searchPlaceholder?: string;
  filters?: { name: string; paramKey: string; options: FilterOption[] }[];
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
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
          className="pl-8"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:contents">
        {filters?.map((filter) => {
          const currentValue = searchParams.get(filter.paramKey) ?? "all";
          const currentLabel =
            currentValue === "all"
              ? `All ${filter.name}`
              : filter.options.find((o) => o.value === currentValue)?.label ?? `All ${filter.name}`;
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
                <SelectItem value="all">All {filter.name}</SelectItem>
                {filter.options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        })}
        {children}
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
