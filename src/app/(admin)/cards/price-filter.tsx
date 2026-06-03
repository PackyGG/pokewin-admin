"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";

export function PriceFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const urlMin = searchParams.get("minPrice") ?? "";
  const urlMax = searchParams.get("maxPrice") ?? "";
  const [min, setMin] = useState(urlMin);
  const [max, setMax] = useState(urlMax);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  // Track the values we last wrote so an EXTERNAL url change (back button,
  // FilterBar's Clear-all / a price chip's ✕) re-syncs the inputs, while our
  // own debounced writes don't clobber mid-typing.
  const lastWrittenMin = useRef(urlMin);
  const lastWrittenMax = useRef(urlMax);

  useEffect(() => {
    if (urlMin !== lastWrittenMin.current) {
      lastWrittenMin.current = urlMin;
      setMin(urlMin);
    }
  }, [urlMin]);
  useEffect(() => {
    if (urlMax !== lastWrittenMax.current) {
      lastWrittenMax.current = urlMax;
      setMax(urlMax);
    }
  }, [urlMax]);

  function update(key: string, value: string) {
    if (key === "minPrice") lastWrittenMin.current = value;
    if (key === "maxPrice") lastWrittenMax.current = value;
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
