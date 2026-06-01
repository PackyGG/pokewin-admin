"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Filter } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * URL-param filter strip for the Top Users tab. Three controls:
 *
 *   • Game (all / packs / battles / upgrader) — chip row
 *   • Min wager — text input, USD, blank = no min
 *   • Country — select; only countries with activity in the period
 *     appear in the dropdown
 *
 * Each control writes its key to the URL search params via
 * `router.replace` so the existing Suspense key (page.tsx) picks the
 * change up and triggers a fresh fetch + skeleton. Other params
 * (period, tab) are preserved.
 *
 * Min-wager is debounced via React's transition (no manual setTimeout)
 * — typing fast doesn't queue 20 navigations.
 */
export function UsersFilters({
  selectedGame,
  minWager,
  selectedCountry,
  countryOptions,
}: {
  selectedGame: "all" | "packs" | "battles" | "upgrader";
  minWager: number;
  selectedCountry: string | null;
  countryOptions: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const p = new URLSearchParams(searchParams.toString());
      if (value === null || value === "") {
        p.delete(key);
      } else {
        p.set(key, value);
      }
      startTransition(() => {
        router.replace(`${pathname}?${p.toString()}`, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  const games: { value: "all" | "packs" | "battles" | "upgrader"; label: string }[] = [
    { value: "all", label: "All" },
    { value: "packs", label: "Packs" },
    { value: "battles", label: "Battles" },
    { value: "upgrader", label: "Upgrader" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card p-3">
      <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Filter className="size-3.5" />
        <span className="font-semibold uppercase tracking-wider">Filters</span>
      </div>

      <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
        {games.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => updateParam("game", value === "all" ? null : value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              selectedGame === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Min wager</span>
        <input
          type="number"
          min={0}
          step={1}
          defaultValue={minWager > 0 ? String(minWager) : ""}
          onChange={(e) => {
            const v = e.target.value.trim();
            updateParam("minWager", v === "" || v === "0" ? null : v);
          }}
          placeholder="$"
          className="w-24 rounded-md border bg-background px-2 py-1 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40"
        />
      </label>

      <label className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Country</span>
        <select
          value={selectedCountry ?? ""}
          onChange={(e) =>
            updateParam(
              "country",
              e.target.value === "" ? null : e.target.value,
            )
          }
          className="rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40"
        >
          <option value="">All</option>
          {countryOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
