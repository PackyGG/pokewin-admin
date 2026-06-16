import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";
import {
  getBattles,
  getBattleDetail,
  type BattleListItem,
  type BattleSortMode,
} from "./battles";
import type { PaginatedResult } from "@/lib/types";

/**
 * Cross-request cache for the two heaviest reads behind /battles —
 * the list query (`getBattles`, which fans battles → participants →
 * game_sessions → provably_fair_results → user_inventory plus a cards
 * price lookup, and on `sortBy=hit` also runs a multiplier CTE) and the
 * detail query (`getBattleDetail`, a deeply-nested per-battle include).
 *
 * On prod the ClickHouse path is dormant, so every list page / detail
 * page repays the full Postgres scan cost on each load. Memoizing the
 * existing query results keyed on the (serializable) URL params means a
 * given view's scan runs at most once per `REVALIDATE_SECONDS`; repeat
 * loads and in-segment navigation resolve from the warmed entry.
 *
 * The numbers are UNCHANGED — this only memoizes the existing query
 * outputs. Same pattern as `users-detail-cache.ts`.
 *
 * DB-env correctness (prod-only cache)
 * ────────────────────────────────────
 * `getBattles` / `getBattleDetail` each call `getDb()` internally, which
 * resolves the per-admin `admin_db_env` cookie. `unstable_cache` runs its
 * callback OUTSIDE the request's dynamic scope, so a `cookies()` read
 * inside it throws and `readDbEnv` falls back to "prod" — the cached
 * callback therefore always queries the PROD client. To avoid serving
 * prod data to a dev-toggled admin we resolve the env OUTSIDE the cache
 * and only memoize when the request is on prod (the default). A
 * dev-toggled admin bypasses the cache and runs the query directly so
 * they always see live dev data.
 */

const REVALIDATE_SECONDS = 60;

export const BATTLES_LIST_TAG = "battles-list";
export const BATTLES_DETAIL_TAG = "battles-detail";

type BattlesListParams = {
  page: number;
  perPage: number;
  status?: string;
  mode?: string;
  search?: string;
  sortBy: BattleSortMode;
  since?: "24h";
};

// `unstable_cache` folds the call arguments into the cache key, so each
// distinct (page, perPage, status, mode, search, sortBy, since) combo
// gets its own entry — paginating / filtering reuses the matching warmed
// scan instead of recomputing it.
const cachedBattlesList = unstable_cache(
  (params: BattlesListParams): Promise<PaginatedResult<BattleListItem>> =>
    getBattles(params),
  ["battles-list-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [BATTLES_LIST_TAG] },
);

const cachedBattleDetail = unstable_cache(
  (id: string) => getBattleDetail(id),
  ["battles-detail-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [BATTLES_DETAIL_TAG] },
);

/** Cached `getBattles` on prod; direct (uncached) on a dev-toggled admin
 * so they see live dev data — see module doc. */
export async function getBattlesCached(
  params: BattlesListParams,
): Promise<PaginatedResult<BattleListItem>> {
  const env = await readDbEnv();
  if (env !== "prod") return getBattles(params);
  return cachedBattlesList(params);
}

/** Cached `getBattleDetail` on prod; direct on dev — see module doc. */
export async function getBattleDetailCached(
  id: string,
): Promise<Awaited<ReturnType<typeof getBattleDetail>>> {
  const env = await readDbEnv();
  if (env !== "prod") return getBattleDetail(id);
  return cachedBattleDetail(id);
}
