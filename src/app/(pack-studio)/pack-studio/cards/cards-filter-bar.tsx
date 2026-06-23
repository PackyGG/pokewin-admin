"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";

import {
  FilterBar,
  EntityViewToggle,
  type FilterSelectSpec,
} from "@/components/entity-surface";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUrlParam } from "@/lib/entity-surface/use-url-state";
import { PriceFilter } from "@/app/(admin)/cards/price-filter";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Pack Studio · Card Editor — filter chrome
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Mirrors the `/cards` filter bar but is ROUTE-LOCAL to `/pack-studio/cards`:
 * every control writes via the shared, pathname-relative `FilterBar` /
 * `useUrlParam` hooks (no hardcoded `/cards` URL like the admin tab-switch), so
 * navigation stays on the pack-studio route.
 *
 *   - set select   → `?set` (UUID or the "unassigned" backlog sentinel).
 *   - search        → debounced `?search`.
 *   - rarity select → `?rarity`, scoped to the active set's rarities.
 *   - price         → the shared min/max `PriceFilter` (`?minPrice`/`?maxPrice`,
 *                     pathname-relative — safe to reuse here).
 *   - unused toggle → `?unused=1`, the "Unused / safely-deletable" filter the
 *                     Card Editor adds. A pressed toggle button (house style),
 *                     surfaced as an active-filter chip via FilterBar.
 *   - view toggle   → grid ⇄ table.
 */

export type CardSetOption = { value: string; label: string };

export function CardsFilterBar({
  setOptions,
  rarities,
}: {
  setOptions: CardSetOption[];
  rarities: string[];
}) {
  const [unused, setUnused] = useUrlParam("unused", { resetPage: true });
  const unusedOn = unused === "1";

  const filters: FilterSelectSpec[] = [
    {
      paramKey: "set",
      label: "Set",
      allLabel: "All sets",
      options: setOptions,
      width: "180px",
    },
    {
      paramKey: "rarity",
      label: "Rarity",
      options: rarities.map((r) => ({ label: r, value: r })),
      width: "160px",
    },
  ];

  const renderChipLabel = React.useCallback(
    (key: string, value: string): React.ReactNode | undefined => {
      switch (key) {
        case "set":
          return `Set: ${setOptions.find((o) => o.value === value)?.label ?? value}`;
        case "rarity":
          return `Rarity: ${value}`;
        case "minPrice":
          return `Min $${value}`;
        case "maxPrice":
          return `Max $${value}`;
        case "unused":
          return value === "1" ? "Unused only" : undefined;
        default:
          return undefined;
      }
    },
    [setOptions],
  );

  const unusedToggle = (
    <Button
      type="button"
      variant={unusedOn ? "default" : "outline"}
      size="sm"
      aria-pressed={unusedOn}
      onClick={() => setUnused(unusedOn ? null : "1")}
      className={cn(
        "h-9 gap-1.5",
        unusedOn &&
          "bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400 border border-emerald-500/30",
      )}
    >
      <ShieldCheck className="size-3.5" />
      Unused only
    </Button>
  );

  return (
    <FilterBar
      search={{ placeholder: "Search by name…", delayMs: 300 }}
      filters={filters}
      filterKeys={["set", "rarity", "minPrice", "maxPrice", "unused"]}
      reservedKeys={["page", "perPage", "sortBy", "sortOrder", "view", "setId"]}
      renderChipLabel={renderChipLabel}
      customControls={
        <>
          <PriceFilter />
          {unusedToggle}
        </>
      }
      trailing={<EntityViewToggle />}
    />
  );
}
