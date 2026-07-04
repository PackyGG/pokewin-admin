import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/admin-db";

/**
 * Persistent "Tuned this fleet" counter (owner feature, 2026-07-04; source
 * corrected 2026-07-04).
 *
 * The workspace KPI shows the REAL remaining count — how many distinct packs
 * have ever been pushed FROM THE RETUNE WORKSPACE, surviving sessions and
 * browsers (unlike the old per-BROWSER "Pushed this session" count).
 *
 * Source: the ADMIN `admin_audit_events` table, restricted to the three event
 * types that ONLY the retune-workspace write actions emit —
 * `pack_retuned` (applyPackRetune), `pack_edited_via_retune` (applyPackEdit),
 * and `pack_edited_and_retuned` (applyStagedPackEditAndRetune). Each of those
 * writes `metadata.pack_id`, so the DISTINCT `metadata->>'pack_id'` over those
 * three types is exactly "distinct packs pushed from the retune workspace".
 *
 * Why NOT `pack_state_snapshots` (the previous source, which over-counted):
 * that table's `action='edit'` snapshot is ALSO captured by the normal /packs
 * edit form (`updatePack`) and by historical/dev edits, so a DISTINCT count
 * over `action in ('edit','retune')` counted every all-time edited pack (~20+),
 * not workspace pushes. The /packs edit form audits `pack_updated` (~241 packs
 * of noise) — which is excluded here by only matching the three retune types.
 *
 * ADMIN-only (no MAIN read) and cheap: a distinct-count over a tiny result set,
 * served by the existing `admin_audit_events_event_type_idx` (event_type).
 */

/**
 * Audit event types emitted ONLY by the retune-workspace write actions
 * (applyPackRetune / applyPackEdit / applyStagedPackEditAndRetune). The normal
 * /packs edit form emits `pack_updated` and is deliberately NOT in this set.
 */
const RETUNE_WORKSPACE_EVENT_TYPES = [
  "pack_retuned",
  "pack_edited_via_retune",
  "pack_edited_and_retuned",
] as const;

/**
 * Distinct pack_ids pushed from the retune workspace at least once, ever —
 * i.e. the count of packs tuned with the retune tool. Cached 60s (the counter
 * is a coarse progress readout, not a live gauge); the post-push
 * `router.refresh()` re-reads it after the cache window, and the three write
 * actions bust the `pack-studio-tuned-count` tag.
 */
export async function getTunedPackCount(): Promise<number> {
  return unstable_cache(
    async () => {
      try {
        // The three retune-workspace event types are a tiny slice of the audit
        // table (single digits of packs). Prisma has no JSON-path DISTINCT, so
        // we pull just the metadata for those rows and distinct pack_id in code.
        const rows = await adminDb.admin_audit_events.findMany({
          where: { event_type: { in: [...RETUNE_WORKSPACE_EVENT_TYPES] } },
          select: { metadata: true },
        });
        const packIds = new Set<string>();
        for (const row of rows) {
          const meta = row.metadata;
          if (meta && typeof meta === "object" && !Array.isArray(meta)) {
            const packId = (meta as { pack_id?: unknown }).pack_id;
            if (typeof packId === "string" && packId.length > 0) {
              packIds.add(packId);
            }
          }
        }
        return packIds.size;
      } catch (err) {
        console.error("[retune] getTunedPackCount failed", err);
        return 0;
      }
    },
    ["pack-studio.retune.tuned-count.v2"],
    { revalidate: 60, tags: ["pack-studio-tuned-count"] },
  )();
}
