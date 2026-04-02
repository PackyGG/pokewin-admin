"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";

export function PriceFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [min, setMin] = useState(searchParams.get("minPrice") ?? "");
  const [max, setMax] = useState(searchParams.get("maxPrice") ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  function update(key: string, value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.set("page", "1");
      startTransition(() => router.replace(`?${params.toString()}`));
    }, 500);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        placeholder="Min $"
        value={min}
        onChange={(e) => {
          setMin(e.target.value);
          update("minPrice", e.target.value);
        }}
        className="w-[100px]"
        min="0"
        step="0.01"
      />
      <span className="text-xs text-muted-foreground">—</span>
      <Input
        type="number"
        placeholder="Max $"
        value={max}
        onChange={(e) => {
          setMax(e.target.value);
          update("maxPrice", e.target.value);
        }}
        className="w-[100px]"
        min="0"
        step="0.01"
      />
    </div>
  );
}
