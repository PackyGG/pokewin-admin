"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ArrowUpDown } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Compact "Sort" dropdown for the Live Leaderboards ranklist — drives the
 * `?rank=` URL param (default `house_cost` keeps a clean URL). Collapses the
 * old 9-chip sort row into one control so the view filter chips next to it
 * stop looking like a second identical chip group. Mirrors the roster
 * toolbar's `RosterSortControl` pattern (`router.replace` in a transition,
 * scroll preserved).
 *
 * The rank values are mirrored from `LIVE_LB_RANKS` in
 * `../_queries/live-leaderboards.ts` (that module is `server-only`, so a
 * client import would throw). Both lists are small and co-owned; the page
 * validates the param server-side either way.
 */

const RANK_LABELS = {
  house_cost: "House cost ↓",
  house_cost_asc: "House cost ↑",
  prize_pool: "Prize ↓",
  prize_pool_asc: "Prize ↑",
  wager: "Wager ↓",
  wager_asc: "Wager ↑",
  ending_soon: "Ending soon",
  starting_soon: "Starting soon",
  recently_ended: "Recently ended",
} as const;

type RankValue = keyof typeof RANK_LABELS;

const RANK_ORDER = Object.keys(RANK_LABELS) as RankValue[];

const DEFAULT_RANK: RankValue = "house_cost";

export function LeaderboardRankSelect({ current }: { current: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const value: RankValue = (RANK_ORDER as readonly string[]).includes(current)
    ? (current as RankValue)
    : DEFAULT_RANK;

  function handleChange(next: string | null) {
    if (!next || !(RANK_ORDER as readonly string[]).includes(next)) return;
    if (next === value) return;
    const params = new URLSearchParams(searchParams.toString());
    // Default rank → drop the param so the canonical view keeps a bare URL.
    if (next === DEFAULT_RANK) params.delete("rank");
    else params.set("rank", next);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    });
  }

  return (
    <Select value={value} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger
        size="sm"
        className="w-[160px] text-xs"
        aria-label="Sort leaderboards"
      >
        <ArrowUpDown className="size-3.5 text-muted-foreground" />
        <SelectValue>{RANK_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {RANK_ORDER.map((rank) => (
          <SelectItem key={rank} value={rank}>
            {RANK_LABELS[rank]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
