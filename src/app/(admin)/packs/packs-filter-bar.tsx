"use client";

import { FilterBar, EntityViewToggle } from "@/components/entity-surface";
import { PacksTabSwitch } from "./_components/packs-tab-switch";

/**
 * Category filter options + chip labels for the `?tag=` param.
 *
 * Values map onto the two structured `packs` taxonomy columns (resolved
 * server-side in getPacks): `pct1`/`pct5`/`pct10` are `pack_tag` enum
 * members matched via `tags.has`; `reward` is the `pack_type` of the free /
 * daily reward packs. There is intentionally NO "sign-up" option — welcome
 * packs share `pack_type = 'reward'` with daily packs and have no distinct
 * catalog signal (see getPacks' PackCategoryFilter doc).
 */
const CATEGORY_OPTIONS = [
  { label: "1%", value: "pct1" },
  { label: "5%", value: "pct5" },
  { label: "10%", value: "pct10" },
  { label: "Daily / Reward packs", value: "reward" },
] as const;

const CATEGORY_CHIP_LABELS: Record<string, string> = {
  pct1: "Category: 1%",
  pct5: "Category: 5%",
  pct10: "Category: 10%",
  reward: "Category: Daily / Reward",
};

/**
 * Filter chrome for the rebuilt /packs list — a thin wrapper over the shared
 * <FilterBar>. Composes:
 *   - leading: the Pokemon / OnePiece pool tab switch (peer of the filters),
 *   - debounced name/slug search,
 *   - a Status select (active / inactive) with an always-visible removable chip,
 *   - a Category select (1% / 5% / 10% / daily-reward packs),
 *   - the grid ⇄ table view toggle, placed beside the dropdowns (customControls
 *     keeps it inside the filter group rather than pushed to the far edge).
 *
 * `set`, `view` and `inspect` are RESERVED (not filters) so "Clear all" / a
 * filter chip's ✕ never wipe the active pool, the chosen view, or an open
 * inspector — only the actual list filters (status + category) clear.
 */
export function PacksFilterBar() {
  return (
    <FilterBar
      leading={<PacksTabSwitch />}
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
        {
          paramKey: "tag",
          label: "Category",
          options: [...CATEGORY_OPTIONS],
          width: "190px",
        },
      ]}
      // View toggle lives in customControls so it renders inline with the
      // Status + Category selects (same gap, h-9 to match the SelectTrigger)
      // instead of being pushed to the trailing edge via `sm:ml-auto`.
      customControls={<EntityViewToggle className="h-9" />}
      filterKeys={["active", "tag"]}
      reservedKeys={["page", "perPage", "sortBy", "sortOrder", "set", "view", "inspect"]}
      renderChipLabel={(key, value) => {
        if (key === "active") {
          return value === "active" ? "Status: Active" : "Status: Inactive";
        }
        if (key === "tag") {
          return CATEGORY_CHIP_LABELS[value];
        }
        return undefined;
      }}
    />
  );
}
