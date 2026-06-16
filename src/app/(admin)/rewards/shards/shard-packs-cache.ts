import "server-only";
import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";
import { getShardPacks, type ShardPacksResult } from "@/lib/queries/packs";

/**
 * Env-keyed cache for the /rewards/shards pack list.
 *
 * `getShardPacks` (in the shared `packs.ts`) runs three uncached reads on
 * every page render — the `pack_type = 'shard'` list, the raw `shard_cost`
 * lookup, and the `pack_cards` group-by. They're bounded but re-paid on each
 * load and on every `?period=` toggle of the stats section below them, even
 * though the pack list never depends on the period. Caching them cross-request
 * makes the first paint cheap.
 *
 * Same env-keyed reasoning as `insights-coins.ts` / `users-detail-cache.ts`:
 * `unstable_cache` runs its callback OUTSIDE request scope, so `cookies()`
 * inside `getDb()` falls back to "prod". We therefore cache ONLY on the prod
 * path (the default + hot path, where `getDb()` correctly resolves to prod
 * inside the callback); a dev-toggled admin runs the read directly so they
 * always see live dev data. 60s revalidate mirrors the sibling pack-stat
 * caches — shard packs change rarely and admin edits revalidate the route.
 *
 * READ-ONLY: delegates to `getShardPacks` (SELECT-only). No writes.
 */
const cachedShardPacks = unstable_cache(
  () => getShardPacks(),
  ["rewards-shards-packs-v1"],
  { revalidate: 60, tags: ["rewards-shards-packs"] },
);

export async function getShardPacksCached(): Promise<ShardPacksResult> {
  const env = await readDbEnv();
  if (env !== "prod") return getShardPacks();
  return cachedShardPacks();
}
