import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/admin-db";

/**
 * Persistent "Tuned this fleet" counter (owner feature, 2026-07-04).
 *
 * The old workspace KPI showed a per-BROWSER "Pushed this session" count that
 * reset on every reload and was invisible across machines. The owner wants the
 * REAL remaining count — how many distinct packs have ever been pushed from the
 * workspace, surviving sessions and browsers.
 *
 * Source: the ADMIN `pack_state_snapshots` table. Every workspace push captures
 * a snapshot with `action` in {"edit","retune"} BEFORE the MAIN write
 * (`applyStagedPackEditAndRetune` / `applyPackRetune` → `capturePackSnapshot`),
 * so the DISTINCT `pack_id` count over those actions is exactly "distinct packs
 * that have a workspace push recorded". This is ADMIN-only (no MAIN read) and
 * cheap: a distinct-count served by the
 * `pack_state_snapshots_action_pack_idx` (action, pack_id) index.
 *
 * NOTE: "edit"/"retune" are also the snapshot actions the Pack Doctor drawer +
 * bulk writers use — a distinct pack tuned via ANY of those paths counts, which
 * matches the owner's intent ("how many packs are done"). "reprice" / "revert" /
 * "build" are excluded (a price re-pin or a revert is not a tune).
 */

/** Snapshot actions that mean "this pack was retuned / edited via the tools". */
const TUNED_ACTIONS = ["edit", "retune"] as const;

/**
 * Distinct pack_ids that have at least one edit/retune snapshot in the ADMIN
 * change history — i.e. the count of packs tuned at least once, ever. Cached
 * 60s (the counter is a coarse progress readout, not a live gauge); the
 * post-push `router.refresh()` re-reads it after the cache window.
 */
export async function getTunedPackCount(): Promise<number> {
  return unstable_cache(
    async () => {
      try {
        const rows = await adminDb.pack_state_snapshots.findMany({
          where: { action: { in: [...TUNED_ACTIONS] } },
          distinct: ["pack_id"],
          select: { pack_id: true },
        });
        return rows.length;
      } catch (err) {
        console.error("[retune] getTunedPackCount failed", err);
        return 0;
      }
    },
    ["pack-studio.retune.tuned-count.v1"],
    { revalidate: 60, tags: ["pack-studio-tuned-count"] },
  )();
}
