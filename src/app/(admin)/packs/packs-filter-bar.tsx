"use client";

import { FilterBar, EntityViewToggle } from "@/components/entity-surface";
import { PacksTabSwitch } from "./_components/packs-tab-switch";

/**
 * Filter chrome for the rebuilt /packs list — a thin wrapper over the shared
 * <FilterBar>. Composes:
 *   - leading: the Pokemon / OnePiece pool tab switch (peer of the filters),
 *   - debounced name/slug search,
 *   - a Status select (active / inactive) with an always-visible removable chip,
 *   - trailing: the grid ⇄ table view toggle.
 *
 * `set`, `view` and `inspect` are RESERVED (not filters) so "Clear all" / the
 * status chip's ✕ never wipe the active pool, the chosen view, or an open
 * inspector — only the actual list filters clear.
 */
export function PacksFilterBar() {
  return (
    <FilterBar
      leading={<PacksTabSwitch />}
      trailing={<EntityViewToggle />}
      search={{ placeholder: "Search by name or slug..." }}
      filters={[
        {
          paramKey: "active",
          label: "Status",
          options: [
            { label: "Active", value: "active" },
            { label: "Inactive", value: "inactive" },
          ],
        },
      ]}
      filterKeys={["active"]}
      reservedKeys={["page", "perPage", "sortBy", "sortOrder", "set", "view", "inspect"]}
      renderChipLabel={(key, value) => {
        if (key === "active") {
          return value === "active" ? "Status: Active" : "Status: Inactive";
        }
        return undefined;
      }}
    />
  );
}
