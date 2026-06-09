"use server";

import { requirePageAccess } from "@/lib/dal";
import { getPackDetail } from "@/lib/queries/packs";

/**
 * Read the full detail (identity + economics + complete card pool, incl.
 * `shardCost`) for a single shard pack, so the /rewards/shards edit dialog
 * can lazy-load the card pool only when the admin actually opens it — the
 * list itself never eager-loads any pack's full card pool.
 *
 * Gated on the shard-management page key. Returns null when the pack is
 * missing or isn't a shard pack, so the dialog can show a not-found state.
 * Read-only; the actual mutation runs through the shared `updatePack`
 * action (which re-validates the shard cost + audits + reloads packs).
 */
export async function getShardPackForEdit(packId: string) {
  await requirePageAccess("/rewards/shards");
  const detail = await getPackDetail(packId);
  if (!detail || detail.packType !== "shard") return null;
  return detail;
}
