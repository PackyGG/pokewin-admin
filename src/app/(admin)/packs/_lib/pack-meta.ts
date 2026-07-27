import { pgArrayParam } from "@/lib/drizzle-array-param";
import { cache } from "react";
import { sql } from "drizzle-orm";

import { getReadDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Minimal pack identity the risk surfaces need from the MAIN game DB but the
 * ADMIN-DB `pack_risk_scores` row does NOT carry: display name/slug, the
 * authoritative current price, and the pack_type.
 * `computePackRiskFromAggregates` is pure math and intentionally doesn't know
 * these — so we batch-read them here rather than widen the engine or the
 * persisted score row.
 */
export type PackMeta = {
  name: string;
  slug: string;
  /** Current sticker price (USD). */
  price: number;
  packType: string;
  active: boolean;
  /**
   * The pack's DB tag list (`packs.tags`, e.g. `"%1"` / `"%5"` / `"%10"`) —
   * the authoritative source for the intended hit-rate
   * (`resolveIntendedHitRate(name, tags)`: DB tags first, name-prefix
   * fallback). Rides the same single PK probe; null when the column is empty.
   */
  tags: string[] | null;
};

/**
 * Batch-read pack identity from MAIN (read-only SELECT) keyed by the score-row
 * pack ids — ONE grouped query (`id = ANY($1)`), never N reads. Returns a
 * `Map<pack_id, PackMeta>`; ids with no matching pack (e.g. a pack deleted on
 * MAIN after its score was written) are simply absent from the map so callers
 * can detect + skip stale score rows.
 *
 * `packs` is a small table (~hundreds of rows); an `id = ANY(...)` lookup is a
 * cheap indexed PK probe.
 *
 * REQUEST-DEDUPED: the ADMIN score read this joins onto is `unstable_cache`d,
 * but this MAIN join deliberately sits OUTSIDE that cache (the request-scoped
 * Drizzle client reads the db-env cookie, which throws inside
 * `unstable_cache`), so it is re-queried on
 * every call. Pack Doctor renders two independent server children off the same
 * snapshot — the grid and the owner re-pin action — which meant two identical
 * `id = ANY(...)` round-trips to MAIN per page load.
 *
 * The dedupe keys on the id set's CONTENT, not the array's identity: every
 * caller builds its list with a fresh `.map()`, so a plain `cache(fn)` over the
 * array argument would never hit (React `cache` compares args by reference).
 * Sorting + joining into one string key makes the two calls collide as intended.
 */
export async function getPackMetaByIds(
  packIds: string[],
): Promise<Map<string, PackMeta>> {
  if (packIds.length === 0) return new Map<string, PackMeta>();
  // Sorted + de-duped so two callers with the same set in a different order
  // still share one round-trip.
  return getPackMetaByKey(Array.from(new Set(packIds)).sort().join(","));
}

/** Content-keyed inner read — one MAIN round-trip per distinct id set per request. */
const getPackMetaByKey = cache(async function getPackMetaByKey(
  key: string,
): Promise<Map<string, PackMeta>> {
  const out = new Map<string, PackMeta>();
  const packIds = key.length === 0 ? [] : key.split(",");
  if (packIds.length === 0) return out;

  const db = await getReadDrizzleDb();
  const result = await db.execute<{
    id: string;
    name: string;
    slug: string;
    price: string;
    pack_type: string;
    active: boolean;
    tags: string[] | null;
  }>(sql`
    SELECT id, name, slug, price::text AS price, pack_type::text AS pack_type,
           active, tags::text[] AS tags
    FROM packs
    WHERE id = ANY(${pgArrayParam(packIds)}::uuid[])
      AND pack_type <> ${"shard"}
  `);

  for (const r of result.rows) {
    out.set(r.id, {
      name: r.name,
      slug: r.slug,
      price: toNumber(r.price),
      packType: r.pack_type,
      active: r.active,
      tags: r.tags ?? null,
    });
  }
  return out;
});
