"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { transition } from "@/components/ux";
import { cn } from "@/lib/utils";

/** Shared debounced `minValue`/`maxValue` URL filter for money lists. */
export function ValueRangeFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [min, setMin] = useState(searchParams.get("minValue") ?? "");
  const [max, setMax] = useState(searchParams.get("maxValue") ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const updateParams = useCallback(
    (minValue: string, maxValue: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const params = new URLSearchParams(searchParams.toString());
        if (minValue) params.set("minValue", minValue);
        else params.delete("minValue");
        if (maxValue) params.set("maxValue", maxValue);
        else params.delete("maxValue");
        params.set("page", "1");
        startTransition(() => router.replace(`?${params.toString()}`));
      }, 500);
    },
    [router, searchParams],
  );

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        transition("opacity", "fast"),
        isPending && "opacity-60",
      )}
      aria-busy={isPending || undefined}
    >
      <Input
        type="number"
        placeholder="Min $"
        value={min}
        onChange={(event) => {
          setMin(event.target.value);
          updateParams(event.target.value, max);
        }}
        className="h-9 w-[100px]"
        min={0}
        step="0.01"
      />
      <span className="text-sm text-muted-foreground">–</span>
      <Input
        type="number"
        placeholder="Max $"
        value={max}
        onChange={(event) => {
          setMax(event.target.value);
          updateParams(min, event.target.value);
        }}
        className="h-9 w-[100px]"
        min={0}
        step="0.01"
      />
    </div>
  );
}
