import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";
import {
  getRainHeader,
  getRainTips,
  type RainHeader,
  type RainTipItem,
} from "./rain";

/**
 * Cross-request cache for the two NON-paginated reads behind /rain/[id]:
 * the detail header (the hero + KPI strip + Details panel source) and the
 * tips list (+ admin-email fan-out for the team flag).
 *
 * Why this exists
 * ───────────────
 * The detail page re-runs its whole server component on every entries
 * pagination (`?page=`) change. The header and the tips list do NOT depend
 * on that cursor, but without a cache layer each `?page=` step would re-pay
 * the header PK lookup, the tips relation load AND the admin_users fan-out.
 * Memoizing them keyed on the rain id means the summary boxes and the tips
 * table resolve from the warmed entry on pagination — only the entries
 * query (uncached, page-keyed) actually hits the DB as the admin pages.
 *
 * The numbers are UNCHANGED — this only memoizes the existing query
 * results. Same pattern as `getUserDetailCached` in users-detail-cache.ts.
 *
 * DB-env correctness (prod-only cache)
 * ────────────────────────────────────
 * `getRainHeader` / `getRainTips` resolve the request-scoped Drizzle client,
 * which reads
 * the per-admin `admin_db_env` cookie. `unstable_cache` runs its callback
 * OUTSIDE the request's dynamic scope, so a `cookies()` read inside it
 * throws and `readDbEnv` falls back to "prod" — the cached callback always
 * queries the PROD client. To avoid serving prod data to a dev-toggled
 * admin we cache ONLY when the request is on prod (the default). A
 * dev-toggled admin bypasses the cache and runs the query directly so they
 * always see live dev data.
 *
 * Staleness: 60s, matching users-detail. The `rain-detail` tag is busted by
 * the base-amount adjust action (rain/actions.ts) so a money-affecting edit
 * surfaces immediately rather than stale-while-revalidate.
 */

const REVALIDATE_SECONDS = 60;

const cachedRainHeader = unstable_cache(
  (id: string): Promise<RainHeader | null> => getRainHeader(id),
  ["rain-detail-header-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: ["rain-detail"] },
);

const cachedRainTips = unstable_cache(
  (id: string): Promise<RainTipItem[]> => getRainTips(id),
  ["rain-detail-tips-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: ["rain-detail"] },
);

/** Cached `getRainHeader` on prod; direct (uncached) on a dev-toggled admin. */
export async function getRainHeaderCached(
  id: string,
): Promise<RainHeader | null> {
  const env = await readDbEnv();
  if (env !== "prod") return getRainHeader(id);
  return cachedRainHeader(id);
}

/** Cached `getRainTips` on prod; direct (uncached) on a dev-toggled admin. */
export async function getRainTipsCached(id: string): Promise<RainTipItem[]> {
  const env = await readDbEnv();
  if (env !== "prod") return getRainTips(id);
  return cachedRainTips(id);
}
