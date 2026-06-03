"use client";

import * as React from "react";
import { FilterBar, type FilterSelectSpec } from "@/components/entity-surface";

/**
 * Filter chrome for /sets, composed from the shared `FilterBar` so the surface
 * matches /cards (grouped always-visible active-filter chips + clear-all +
 * debounced search) instead of the legacy DataTableToolbar's single opaque
 * "Clear" button.
 *
 *   - search        → debounced `?search` (built into FilterBar).
 *   - series select → `?series`, populated from the distinct-series list.
 *
 * The URL param contract is unchanged from the old toolbar (`?search`,
 * `?series`; `page`/`perPage`/`sortBy`/`sortOrder` reserved) so the server
 * page's query inputs and pagination keep working exactly as before — this is
 * purely a presentation swap.
 *
 * `renderChipLabel` lives on this client boundary (functions can't cross the
 * RSC edge); the server passes only the serializable series options in.
 */
export function SetsFilterBar({
  seriesOptions,
}: {
  seriesOptions: { label: string; value: string }[];
}) {
  const filters: FilterSelectSpec[] = [
    {
      paramKey: "series",
      label: "Series",
      options: seriesOptions,
      width: "160px",
    },
  ];

  const renderChipLabel = React.useCallback(
    (key: string, value: string): React.ReactNode | undefined => {
      if (key === "series") return `Series: ${value}`;
      return undefined;
    },
    [],
  );

  return (
    <FilterBar
      search={{ placeholder: "Search by name…", delayMs: 300 }}
      filters={filters}
      filterKeys={["series"]}
      reservedKeys={["page", "perPage", "sortBy", "sortOrder"]}
      renderChipLabel={renderChipLabel}
    />
  );
}
