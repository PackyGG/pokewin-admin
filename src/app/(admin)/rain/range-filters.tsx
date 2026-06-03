"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { transition } from "@/components/ux";

function RangeInput({
  label,
  minKey,
  maxKey,
}: {
  label: string;
  minKey: string;
  maxKey: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [min, setMin] = useState(searchParams.get(minKey) ?? "");
  const [max, setMax] = useState(searchParams.get(maxKey) ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const updateParams = useCallback(
    (minVal: string, maxVal: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const params = new URLSearchParams(searchParams.toString());
        if (minVal) params.set(minKey, minVal);
        else params.delete(minKey);
        if (maxVal) params.set(maxKey, maxVal);
        else params.delete(maxKey);
        params.set("page", "1");
        startTransition(() => router.replace(`?${params.toString()}`));
      }, 500);
    },
    [searchParams, router, minKey, maxKey],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        transition("opacity", "fast"),
        isPending && "opacity-60",
      )}
      aria-busy={isPending || undefined}
    >
      <span className="text-xs text-muted-foreground whitespace-nowrap">{label}</span>
      <Input
        type="number"
        placeholder="Min"
        value={min}
        onChange={(e) => {
          setMin(e.target.value);
          updateParams(e.target.value, max);
        }}
        className="w-[80px] h-9"
        min={0}
        step="0.01"
      />
      <span className="text-muted-foreground text-sm">–</span>
      <Input
        type="number"
        placeholder="Max"
        value={max}
        onChange={(e) => {
          setMax(e.target.value);
          updateParams(min, e.target.value);
        }}
        className="w-[80px] h-9"
        min={0}
        step="0.01"
      />
    </div>
  );
}

export function RainRangeFilters() {
  return (
    <>
      <RangeInput label="Tips $" minKey="minTips" maxKey="maxTips" />
      <RangeInput label="Pool $" minKey="minPool" maxKey="maxPool" />
      <RangeInput label="Participants" minKey="minParticipants" maxKey="maxParticipants" />
    </>
  );
}
