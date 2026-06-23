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
 * One pack that has captured history — the picker option set. Resolved
 * server-side from the union of pack ids present in the change history, so the
 * picker only ever lists packs the owner can actually drill into.
 */
export type PackOption = {
  packId: string;
  name: string;
};

const ALL = "all";

/**
 * Pack picker for the Change History timeline. Querystring-driven (`?pack=<id>`)
 * — selecting a pack scopes the timeline to that pack's full history; "All
 * packs" clears the param and shows the most-recent snapshots across the whole
 * catalog. A thin client wrapper around URL state (no local state, no eager
 * fetching): the server component re-reads the scoped history on each change,
 * mirroring the Pack Doctor filter bar.
 */
export function HistoryPackFilter({ options }: { options: PackOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const current = searchParams.get("pack") ?? ALL;
  const active = current !== ALL;

  const setPack = useCallback(
    (value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === null || value === ALL) {
        params.delete("pack");
      } else {
        params.set("pack", value);
      }
      const qs = params.toString();
      router.push(qs ? `?${qs}` : "?");
    },
    [router, searchParams],
  );

  // Nothing to filter by — render nothing (the timeline shows everything).
  if (options.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Pack</span>
      <Select value={current} onValueChange={setPack}>
        <SelectTrigger className="h-8 w-[260px]" aria-label="Filter by pack">
          <SelectValue placeholder="All packs" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All packs</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.packId} value={o.packId}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {active && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 text-muted-foreground"
          onClick={() => setPack(ALL)}
        >
          <X className="size-3.5" aria-hidden />
          Clear
        </Button>
      )}
    </div>
  );
}
