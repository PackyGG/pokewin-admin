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
import { cn } from "@/lib/utils";
import {
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import {
  CreatorsSortMode,
  type CreatorsSortMode as SortMode,
  CREATORS_MIN_PERIOD,
  CREATORS_PERIODS,
  clampCreatorsPeriod,
} from "../_lib/search-params";

/**
 * Sort + period controls for the /creators list.
 *
 * `<CreatorsSortControl>` drives the `?sortBy=` param via a Select.
 * Modes (mirroring `CreatorsSortMode`):
 *   • recent   — default (active-deal creators pinned client-side)
 *   • ggr_desc — biggest house win first (windowed code-user GGR ↓)
 *   • ggr_asc  — biggest house loss first (GGR ↑)
 *   • ftd_desc — most first-time depositors first
 *   • ftd_asc  — fewest first-time depositors first
 *
 * `<CreatorsPeriodControl>` drives the `?period=` param via chips — it
 * scopes the windowed code-user GGR shown on each row + the roster-wide
 * Net Code-User GGR tile. Only the selected window is fetched per render
 * (active-timeframe-only); switching it is a fresh navigation.
 *
 * Both use `router.replace` so the change doesn't pollute history, drop
 * `page` (a new sort/window starts on page 1), and run inside a
 * transition so the toolbar stays responsive while the boundary streams.
 *
 * Client-safe: imports only the Select primitives, the period constants
 * (client-safe module — no DB), and the sort-mode enum — no server
 * query-module value imports.
 */

const SORT_LABELS: Record<SortMode, string> = {
  recent: "Recent",
  ggr_desc: "GGR (house win) ↓",
  ggr_asc: "GGR (house loss) ↑",
  ftd_desc: "FTDs ↓",
  ftd_asc: "FTDs ↑",
};

// The Select option order — Recent first (default), then the GGR pair,
// then the FTD pair.
const SORT_OPTIONS: SortMode[] = [
  "recent",
  "ggr_desc",
  "ggr_asc",
  "ftd_desc",
  "ftd_asc",
];

export function CreatorsSortControl() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const raw = searchParams.get("sortBy");
  const current: SortMode = CreatorsSortMode.safeParse(raw).success
    ? (raw as SortMode)
    : "recent";

  function handleChange(next: string | null) {
    const parsed = CreatorsSortMode.safeParse(next);
    if (!parsed.success) return;
    const params = new URLSearchParams(searchParams.toString());
    if (parsed.data === "recent") {
      // `recent` is the default — drop the param so the URL stays clean.
      params.delete("sortBy");
    } else {
      params.set("sortBy", parsed.data);
    }
    // A new sort always restarts on page 1.
    params.delete("page");
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <Select value={current} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger
        className="h-9 w-[180px] text-xs"
        aria-label="Sort creators"
      >
        <ArrowUpDown className="size-3.5 text-muted-foreground" />
        <SelectValue>{SORT_LABELS[current]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {SORT_OPTIONS.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {SORT_LABELS[mode]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CreatorsPeriodControl() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // /creators enforces 48h as the SHORTEST selectable window — the
  // sub-48h chips (1h/3h/6h/12h/24h) are dropped from the rendered set,
  // and any `?period=` below 48h (or absent → the global 24h default) is
  // clamped UP to 48h so the active chip is always one that's shown.
  // Reuses the shared parse/clamp helper so the control and the server
  // page agree on the effective window.
  const current: DashboardPeriod = clampCreatorsPeriod(
    searchParams.get("period"),
  );

  function handleSelect(period: DashboardPeriod) {
    if (period === current) return;
    const params = new URLSearchParams(searchParams.toString());
    // 48h is the /creators minimum AND its clean-URL sentinel — selecting
    // it drops the param (the page clamps a missing param up to 48h), so
    // the canonical /creators URL carries no `?period=`.
    if (period === CREATORS_MIN_PERIOD) {
      params.delete("period");
    } else {
      params.set("period", period);
    }
    // The windowed GGR re-orders the rows under ggr_* sorts, so reset to
    // page 1 — same reasoning as the sort control.
    params.delete("page");
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <div
      role="group"
      aria-label="GGR window"
      className={cn(
        "inline-flex flex-wrap gap-0.5 rounded-lg border border-border/60 bg-muted/30 p-0.5",
        isPending && "opacity-60",
      )}
    >
      {CREATORS_PERIODS.map((period) => {
        const active = period === current;
        return (
          <button
            key={period}
            type="button"
            aria-pressed={active}
            title={DASHBOARD_PERIOD_LABELS[period]}
            onClick={() => handleSelect(period)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-medium uppercase transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {period === "all" ? "All" : period}
          </button>
        );
      })}
    </div>
  );
}
