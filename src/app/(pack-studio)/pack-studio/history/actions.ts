"use server";

import { redirect } from "next/navigation";

import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isOwner } from "@/lib/owners";
import { isUuid } from "@/lib/utils/ids";
import {
  getLivePackPool,
  getHistoryCardMeta,
  type LivePoolCard,
  type HistoryCardMeta,
} from "@/app/(admin)/packs/_lib/pack-history";

/**
 * Pack History — owner-only server actions backing the timeline UI's "DIFF vs
 * current" expansion. The page itself is owner-only (`page.tsx` + this gate),
 * the action re-checks owner before reading the LIVE pool. Reads ADMIN-fresh
 * card meta in the same call so the client gets one round-trip.
 *
 * Dual-DB: MAIN is read-only here (pool + card meta SELECTs); ADMIN is not
 * touched. Same discipline as the page reads.
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

  const pool = await getLivePackPool(packId);
  if (pool.length === 0) return [];

  const meta: Map<string, HistoryCardMeta> = await getHistoryCardMeta(
    pool.map((c) => c.cardId),
  );

  return pool.map((c) => {
    const m = meta.get(c.cardId);
    return {
      cardId: c.cardId,
      weight: c.weight,
      value: c.value,
      name: m?.name ?? null,
      imageUrl: m?.imageUrl ?? null,
    };
  });
}
