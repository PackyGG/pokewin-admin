"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Pack Doctor filter bar. Every control is querystring-driven so the Overview
 * surface can deep-link straight into a filtered grid (e.g.
 * `?belowTarget=1`, `?tier=T5`). Selecting "all" clears that param; the boolean
 * toggles set the param to `1` or remove it. Mirrors the read shape consumed by
 * `getPackRiskRows` (see the page server component that maps params → filters).
 *
 * Stays a thin client wrapper around URL state: no local state, no eager
 * fetching — changing a control just pushes a new querystring and the server
 * component re-reads the active filter set.
 */

const TIERS = ["T1", "T2", "T3", "T4", "T5"] as const;
const ALL = "all";

/** Boolean compliance toggles → their querystring key + button label. */
const BOOL_FILTERS: { key: string; label: string }[] = [
  { key: "belowTarget", label: "Below target" },
  { key: "overCap", label: "Over cap" },
  { key: "zeroNearMiss", label: "Zero near-miss" },
];

export function DoctorFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tier = searchParams.get("tier") ?? ALL;
  const type = searchParams.get("type") ?? ALL;

  const push = useCallback(
    (params: URLSearchParams) => {
      const qs = params.toString();
      router.push(qs ? `?${qs}` : "?");
    },
    [router],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === null || value === ALL) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      push(params);
    },
    [searchParams, push],
  );

  const toggleBool = useCallback(
    (key: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (params.get(key) === "1") {
        params.delete(key);
      } else {
        params.set(key, "1");
      }
      push(params);
    },
    [searchParams, push],
  );

  const hasAnyFilter =
    tier !== ALL ||
    type !== ALL ||
    BOOL_FILTERS.some((f) => searchParams.get(f.key) === "1");

  function clearAll() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tier");
    params.delete("type");
    for (const f of BOOL_FILTERS) params.delete(f.key);
    push(params);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={tier} onValueChange={(v) => setParam("tier", v)}>
        <SelectTrigger className="h-8 w-[120px]" aria-label="Filter by tier">
          <SelectValue placeholder="All tiers" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All tiers</SelectItem>
          {TIERS.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={type} onValueChange={(v) => setParam("type", v)}>
        <SelectTrigger className="h-8 w-[130px]" aria-label="Filter by pack type">
          <SelectValue placeholder="All types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All types</SelectItem>
          <SelectItem value="official">Official</SelectItem>
          <SelectItem value="custom">Custom</SelectItem>
        </SelectContent>
      </Select>

      {BOOL_FILTERS.map((f) => {
        const active = searchParams.get(f.key) === "1";
        return (
          <Button
            key={f.key}
            type="button"
            size="sm"
            variant={active ? "default" : "outline"}
            className="h-8"
            aria-pressed={active}
            onClick={() => toggleBool(f.key)}
          >
            {f.label}
          </Button>
        );
      })}

      {hasAnyFilter && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 text-muted-foreground"
          onClick={clearAll}
        >
          <X className="size-3.5" aria-hidden />
          Clear
        </Button>
      )}
    </div>
  );
}
