"use server";

import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";

import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { getReadDrizzleDb } from "@/lib/db";
import { isOwner } from "@/lib/owners";
import { isUuid } from "@/lib/utils/ids";
import type { LivePoolCard } from "@/app/(admin)/packs/_lib/pack-history";

/**
 * Pack History — owner-only server actions backing the timeline UI's "DIFF vs
 * current" expansion. The page itself is owner-only (`page.tsx` + this gate),
 * the action re-checks owner before reading the LIVE pool. Pool weights and
 * per-card identity come back in ONE read, so the client gets one round-trip
 * and the server spends one MAIN read slot.
 *
 * Dual-DB: MAIN is read-only here (one pool query); ADMIN is not touched.
 * Same discipline as the page reads.
 */

export type LivePoolCardWithMeta = LivePoolCard & {
  name: string | null;
  imageUrl: string | null;
};

/**
 * Returns the LIVE pool of a pack joined to per-card identity + value, for the
 * "DIFF vs current" overlay in the history row drawer. Owner-only. Returns `[]`
 * when the pack doesn't exist (a snapshot for a deleted pack has nothing to
 * diff against).
 */
export async function getLivePackPoolForDiff(
  packId: string,
): Promise<LivePoolCardWithMeta[]> {
  const session = await requirePackStudioPageAccess();
  if (!isOwner(session)) {
    // Same surface as the page — non-owners get bounced off Studio.
    redirect("/pack-studio");
  }
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  // ONE MAIN read. This used to be two SERIAL round-trips — the live-pool
  // helper (pack_cards ⋈ cards for value+weight) followed by the history
  // card-meta helper (a `cards` PK probe for name+image) — over the SAME
  // `cards` rows the first query had already joined. Selecting the two extra
  // columns in the existing join is exactly equivalent — both helpers read
  // `cards.price` as the value, and the inner join already drops a card missing
  // from `cards`, so the second read could never contribute a row the first
  // didn't have — and it halves the drawer's cost under the process-wide MAIN
  // read admission cap.
  //
  // Index path is unchanged from `getPackCardValues`: `pack_cards.pack_id`
  // (leading column of the `pack_cards_pack_id_card_id_unique` composite) then
  // `cards_pkey` on the join.
  const db = await getReadDrizzleDb();
  const result = await db.execute<{
    card_id: string;
    value: string | null;
    weight: number;
    name: string | null;
    image_url: string | null;
  }>(sql`
    SELECT
      pc.card_id      AS card_id,
      c.price::text   AS value,
      pc.weight       AS weight,
      c.name          AS name,
      c.image_url     AS image_url
    FROM pack_cards pc
    JOIN cards c ON c.id = pc.card_id
    WHERE pc.pack_id = ${packId}::uuid
    ORDER BY pc."order" ASC
  `);

  return result.rows.map((r) => ({
    cardId: r.card_id,
    weight: Number(r.weight),
    value: Number(r.value ?? 0),
    name: r.name,
    imageUrl: r.image_url,
  }));
}
