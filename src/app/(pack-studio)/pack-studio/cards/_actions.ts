"use server";

import { getCardIdsForFilter } from "@/lib/queries/cards";
import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import {
  getDeletableCardIds,
  getCardUsageFlags,
  deleteCards,
} from "@/app/(admin)/cards/actions";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Pack Studio · Card Editor — on-demand server actions
 * ──────────────────────────────────────────────────────────────────────────
 *
 * These back the deferred reads + the destructive "Delete all unused" flow on
 * the Pack-Studio Card Editor. They live HERE (not under `(admin)/cards`) so
 * they carry the Pack-Studio access gate (`requirePackStudioAccess`) rather
 * than the `/cards` page gate — a pack-studio-eligible operator without
 * `/cards` page access can still browse the catalog here.
 *
 * The two reference/usage helpers reuse the canonical `(admin)/cards/actions`
 * primitives so the "is this card safe to delete" rules can NEVER drift between
 * the two surfaces:
 *
 *   - `loadCardIdsForUnusedFilter` → ids matching the active list filter
 *     (capped), then narrowed to the SAFELY-DELETABLE subset via the shared
 *     `getDeletableCardIds`. Read-only (MAIN SELECT/COUNT only).
 *   - `getCardSafety` → per-id safe/blocked split for the visible/selected set,
 *     sourced verbatim from `getDeletableCardIds`. Read-only.
 *
 * The destructive `deletePackStudioCards` simply re-exports the admin-only,
 * server-audited `deleteCards` (it self-enforces `requireAdmin()` + writes a
 * `cards_bulk_deleted` audit event). We add the Pack-Studio gate on top so a
 * non-eligible caller is rejected before the admin gate even runs.
 *
 * NOTE on the underlying reference reads: `getDeletableCardIds` is admin-only
 * (`requireAdmin()` inside `(admin)/cards/actions`). The safety column +
 * unused filter therefore only populate for admins; non-admin pack-studio
 * operators see usage (`inPacks`) but the safety badge degrades to "unknown"
 * (the client treats a thrown call as a non-fatal absence). The destructive
 * delete is admin-only by design, so this matches the task's "admin-only +
 * audited server-side" requirement exactly.
 */

/** Reason a single card can't be deleted, mirrored from `getDeletableCardIds`. */
export type CardBlockedReason =
  | "in_packs"
  | "in_inventory"
  | "in_upgrader_output"
  | "in_upgrader_target"
  | "in_provably_fair";

export type CardSafetyResult = {
  deletable: string[];
  blocked: { id: string; reason: CardBlockedReason }[];
};

/** Filter predicate shape shared with the list query (active-set folded in). */
export type CardsFilterInput = {
  search?: string;
  rarity?: string;
  setId?: string;
  minPrice?: string;
  maxPrice?: string;
};

/**
 * Per-card safe/blocked split for an explicit id set (the rows currently
 * visible, or the current bulk selection). Admin-only at the data layer — the
 * Pack-Studio gate runs first, then `getDeletableCardIds` enforces
 * `requireAdmin()`. Read-only.
 */
export async function getCardSafety(
  ids: string[],
): Promise<CardSafetyResult> {
  await requirePackStudioAccess();
  if (ids.length === 0) return { deletable: [], blocked: [] };
  return getDeletableCardIds(ids);
}

/** Full per-card usage flag set, mirrored from the admin `getCardUsageFlags`. */
export type CardUsageFlags = {
  id: string;
  inPacks: boolean;
  inInventory: boolean;
  inUpgrader: boolean;
  inProvablyFair: boolean;
  safeToDelete: boolean;
};

/**
 * Full per-card usage flags for an explicit id set (the rows currently
 * visible). Unlike `getCardSafety` (first-reason only), this returns one boolean
 * per reference class so the explorer can render EVERY usage category as its own
 * badge plus a single "safe to delete" sign. `safeToDelete` is the exact same
 * notion the unused filter + delete flow use (`checkCardReferences.deletableIds`),
 * so they can never drift. Admin-only at the data layer (Pack-Studio gate first,
 * then `getCardUsageFlags` enforces `requireAdmin()`). Read-only.
 */
export async function getCardUsageFlagsForCards(
  ids: string[],
): Promise<CardUsageFlags[]> {
  await requirePackStudioAccess();
  if (ids.length === 0) return [];
  return getCardUsageFlags(ids);
}

/**
 * Ids of cards matching the active list filter that are ALSO safely deletable.
 * Two-step, both read-only: (1) pull the matching id set (capped — the same
 * 500-id ceiling a single bulk delete consumes), (2) narrow to the unreferenced
 * subset via the shared reference check. Powers both the "Delete all unused"
 * flow and (when narrowed to the visible page) the "Unused" filter.
 */
export async function loadCardIdsForUnusedFilter(
  filter: CardsFilterInput,
  limit: number,
): Promise<CardSafetyResult & { scanned: number }> {
  await requirePackStudioAccess();
  const capped = Math.max(1, Math.min(limit || 500, 500));
  const ids = await getCardIdsForFilter(filter, capped);
  if (ids.length === 0) {
    return { deletable: [], blocked: [], scanned: 0 };
  }
  const safety = await getCardSafety(ids);
  return { ...safety, scanned: ids.length };
}

/**
 * Destructive bulk delete — admin-only + audited server-side. Re-exports the
 * canonical `(admin)/cards/actions.deleteCards` (which enforces `requireAdmin()`
 * and writes the `cards_bulk_deleted` audit event) behind the Pack-Studio gate.
 * Skips + reports any card still referenced (packs / inventory / upgrader /
 * provably-fair) rather than orphaning it.
 */
export async function deletePackStudioCards(input: { ids: string[] }) {
  await requirePackStudioAccess();
  return deleteCards(input);
}
