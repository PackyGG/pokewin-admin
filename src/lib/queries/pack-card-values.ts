import { sql } from "drizzle-orm";
import { getDrizzleDb } from "@/lib/db";

/**
 * One row per pool card of a pack, reduced to the facts the weight-shaping
 * solver (`shapeWeights`) and the risk engine (`computePackRisk`) need:
 *   - cardId  — the `cards.id` (and `pack_cards.card_id`)
 *   - value   — the card's sticker `cards.price` (the item's value; a voucher is
 *               the same as a card, so price is the value either way)
 *   - weight  — the current pool weight (`pack_cards.weight`)
 *
 * Returned as plain numbers (Decimal cast to text in SQL and re-parsed) so the
 * shape stays serializable and JS-arithmetic-safe.
 */
export type PackCardValue = {
  cardId: string;
  value: number;
  weight: number;
};

/**
 * READ-ONLY (MAIN game DB): fetch a pack's full card pool as
 * `{cardId, value, weight}[]`, ordered by `pack_cards.order` so the caller can
 * preserve display order on a re-write. `value = cards.price`.
 *
 * Index path (EXPLAIN-verified against prod): filters on `pack_cards.pack_id`
 * (covered by the `pack_cards_pack_id_card_id_unique` composite index, leading
 * column `pack_id`, Bitmap Index Scan) and joins `cards` on its primary key
 * (`cards_pkey`, Index Scan) — never a seq-scan. Not cached: every caller (the
 * retune dry-run + the authoritative write) needs fresh truth immediately
 * before computing/persisting weights.
 *
 * Returns `[]` for a pack with no cards (or a non-existent id) — the caller
 * treats an empty pool as infeasible.
 */
export async function getPackCardValues(
  packId: string,
): Promise<PackCardValue[]> {
  const db = await getDrizzleDb();

  const result = await db.execute<{
    card_id: string;
    value: string | null;
    weight: number;
  }>(sql`
      SELECT
        pc.card_id      AS card_id,
        c.price::text   AS value,
        pc.weight       AS weight
      FROM pack_cards pc
      JOIN cards c ON c.id = pc.card_id
      WHERE pc.pack_id = ${packId}::uuid
      ORDER BY pc.order ASC
  `);

  return result.rows.map((r) => ({
    cardId: r.card_id,
    value: Number(r.value ?? 0),
    weight: Number(r.weight),
  }));
}
