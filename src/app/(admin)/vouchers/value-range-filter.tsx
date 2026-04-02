"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";

export function ValueRangeFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [min, setMin] = useState(searchParams.get("minValue") ?? "");
  const [max, setMax] = useState(searchParams.get("maxValue") ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const updateParams = useCallback(
    (minVal: string, maxVal: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const params = new URLSearchParams(searchParams.toString());
        if (minVal) {
          params.set("minValue", minVal);
        } else {
          params.delete("minValue");
        }
        if (maxVal) {
          params.set("maxValue", maxVal);
        } else {
          params.delete("maxValue");
        }
        params.set("page", "1");
        startTransition(() => router.replace(`?${params.toString()}`));
      }, 500);
    },
    [searchParams, router]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        placeholder="Min $"
        value={min}
        onChange={(e) => {
          setMin(e.target.value);
          updateParams(e.target.value, max);
        }}
        className="w-[100px] h-9"
        min={0}
        step="0.01"
      />
      <span className="text-muted-foreground text-sm">–</span>
      <Input
        type="number"
        placeholder="Max $"
        value={max}
        onChange={(e) => {
          setMax(e.target.value);
          updateParams(min, e.target.value);
        }}
        className="w-[100px] h-9"
        min={0}
        step="0.01"
      />
    </div>
  );
}
