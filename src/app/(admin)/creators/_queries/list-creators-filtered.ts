import "server-only";

import { creatorsApi, type CreatorListItem } from "@/lib/backend-api";
import type { CreatorsListPage } from "./list-creators";

export type CreatorFilter = "live" | "active-deals";

/**
 * Fetches the full creator list from the backend and narrows it
 * in-memory to one of the KPI segments that the /creators page hero
 * tiles count. Used when an admin clicks the "Live Now" or
 * "Active Deals" tile to drill down into the matching creators.
 *
 * Returns the same `CreatorsListPage` shape as `listCreatorsForPage`
 * so the page component can swap between the two without branching
 * its render path. Pagination is collapsed to a single page — the
 * filtered population is expected to be small (typically a handful
 * to low tens), so chasing pagination across the filter would only
 * make the UX worse. If the filtered set ever exceeds 1000 the
 * safety stop kicks in and the result silently truncates (same
 * defensive cap as `getCreatorTopCounts`).
 *
 * The backend has no live / status filter on /admin/creators, so
 * we paginate everything 100-at-a-time (limit cap mirrors the
 * frontend zod schema) and filter client-side. Search, if any, is
 * forwarded to the backend so "live creators named alice" still
 * uses the backend's username/email index instead of pulling the
 * whole population just to discard most of it.
 *
 * Match predicates match exactly what `creator-card-grid.tsx`
 * renders so the count tiles, the chip, and the filtered list all
 * agree:
 *   - "live"         → `active_session_id !== null` (the pulsing dot)
 *   - "active-deals" → `current_deal?.status === "active"` (emerald badge)
 */
export async function listCreatorsFiltered(
  filter: CreatorFilter,
  search?: string,
): Promise<CreatorsListPage> {
  const all: CreatorListItem[] = [];
  const limit = 100;
  const max = 1000;
  let offset = 0;

  while (offset < max) {
    let page;
    try {
      page = await creatorsApi.list({ offset, limit, search });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `listCreatorsFiltered(${filter}): creatorsApi.list failed at offset=${offset} limit=${limit}: ${cause}`,
        { cause: err },
      );
    }
    all.push(...page.data);
    offset += limit;
    if (offset >= page.total || page.data.length < limit) break;
  }

  const data = all.filter((c) => {
    if (filter === "live") return c.active_session_id !== null;
    return c.current_deal?.status === "active";
  });

  return {
    data,
    total: data.length,
    page: 1,
    // `perPage` mirrors the rendered slice — gives the pagination
    // component a sane value if it ever renders alongside the
    // filtered view (currently it doesn't, see page.tsx).
    perPage: data.length || 1,
    totalPages: 1,
  };
}
