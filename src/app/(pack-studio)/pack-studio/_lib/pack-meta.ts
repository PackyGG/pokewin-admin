import { getDb } from "@/lib/db";
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
 */
export async function getPackMetaByIds(
  packIds: string[],
): Promise<Map<string, PackMeta>> {
  const out = new Map<string, PackMeta>();
  if (packIds.length === 0) return out;

  const db = await getDb();
  const rows = await db.$queryRawUnsafe<
    {
      id: string;
      name: string;
      slug: string;
      price: string;
      pack_type: string;
      active: boolean;
    }[]
  >(
    `SELECT id, name, slug, price::text AS price, pack_type, active
     FROM packs
     WHERE id = ANY($1::uuid[])`,
    packIds,
  );

  for (const r of rows) {
    out.set(r.id, {
      name: r.name,
      slug: r.slug,
      price: toNumber(r.price),
      packType: r.pack_type,
      active: r.active,
    });
  }
  return out;
}
