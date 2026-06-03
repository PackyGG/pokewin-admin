"use client";

import * as React from "react";
import {
  FilterBar,
  EntityViewToggle,
  type FilterSelectSpec,
} from "@/components/entity-surface";
import { PriceFilter } from "./price-filter";
import { CardsTabSwitch, type CardSetTab } from "./_components/cards-tab-switch";

/**
 * Filter chrome for the /cards rebuild, composed from the shared `FilterBar`:
 *
 *   - leading slot  → the per-set TAB switch (Pokemon / OnePiece / A–Z / the
 *     new Unassigned backlog tab).
 *   - search        → debounced `?search` (built into FilterBar).
 *   - rarity select → `?rarity`, scoped to the active set's rarities.
 *   - custom control→ the existing min/max PriceFilter (`?minPrice`/`?maxPrice`).
 *   - trailing slot → the grid⇄table VIEW toggle.
 *
 * Always-visible ACTIVE-filter chips (rarity / price) with per-chip remove +
 * Clear-all come from FilterBar for free. The old hidden SetFilter dropdown is
 * gone — the Unassigned TAB supersedes it, killing the two-filtering-systems
 * redundancy the discovery flagged.
 *
 * `?set`, `?view`, pagination and sort are RESERVED (not filters) so they don't
 * appear as removable chips and Clear-all leaves the active tab/view intact.
 */
export function CardsFilterBar({
  tabs,
  rarities,
}: {
  tabs: CardSetTab[];
  rarities: string[];
}) {
  const filters: FilterSelectSpec[] = [
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
        case "rarity":
          return `Rarity: ${value}`;
        case "minPrice":
          return `Min $${value}`;
        case "maxPrice":
          return `Max $${value}`;
        default:
          return undefined;
      }
    },
    [],
  );

  return (
    <FilterBar
      search={{ placeholder: "Search by name…", delayMs: 300 }}
      filters={filters}
      filterKeys={["rarity", "minPrice", "maxPrice"]}
      reservedKeys={["page", "perPage", "sortBy", "sortOrder", "set", "view", "setId"]}
      renderChipLabel={renderChipLabel}
      customControls={<PriceFilter />}
      leading={tabs.length > 0 ? <CardsTabSwitch tabs={tabs} /> : undefined}
      trailing={<EntityViewToggle />}
    />
  );
}
