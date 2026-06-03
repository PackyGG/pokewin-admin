"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getMoveDialogData,
  getCardInspector,
  getCardIdsForFilter,
  type MoveDialogData,
  type CardInspector,
} from "@/lib/queries/cards";
import { isUuid } from "@/lib/utils/ids";

// Mirror of `bulkMoveCardsToSet`'s 500-id ceiling — the action never returns
// more ids than a single move can consume, regardless of the requested limit.
const MAX_SELECT_ALL = 500;

/**
 * On-demand read actions backing the /cards rebuild's DEFERRED data — the
 * pieces CLAUDE.md's "don't load hidden components" rule says must not be
 * eager-fetched on every list render:
 *
 *   - `loadMoveDialogData`  → the bulk-move dialog's set list + series options.
 *     Previously `getSetsForMoveDialog()` + `getDistinctSeries()` ran on EVERY
 *     list paint even though the dialog is closed by default; now they run only
 *     when the dialog actually opens.
 *   - `loadCardInspector`   → the lean card detail for the in-list inspector
 *     sheet, fetched only when a row is opened (the sheet body is gated behind
 *     LazyModalContent, so this never blocks the list).
 *
 * Both gate on `requirePageAccess('/cards')` so a tampered RPC matches the
 * page's permission model exactly. Read-only — no mutation, no audit event.
 */

export async function loadMoveDialogData(): Promise<MoveDialogData> {
  await requirePageAccess("/cards");
  return getMoveDialogData();
}

export async function loadCardInspector(
  id: string,
): Promise<CardInspector | null> {
  await requirePageAccess("/cards");
  // Shape-check the id before any DB call (defence in depth — a malformed id
  // would otherwise reach the `::uuid` cast in the raw cost/power probe).
  if (!isUuid(id)) return null;
  return getCardInspector(id);
}

/**
 * Ids of every card matching the bulk toolbar's current filter, capped so the
 * returned set is always movable in one `bulkMoveCardsToSet` call. The caller
 * passes the SAME resolved filter the visible list uses (active-set already
 * folded in by the page) so selection matches what's on screen. `limit` is
 * clamped to {@link MAX_SELECT_ALL} server-side so a tampered call can't pull
 * an unbounded id list.
 */
export async function fetchCardIdsForFilter(
  filter: {
    search?: string;
    rarity?: string;
    setId?: string;
    minPrice?: string;
    maxPrice?: string;
  },
  limit: number,
): Promise<string[]> {
  await requirePageAccess("/cards");
  const capped = Math.max(1, Math.min(limit || MAX_SELECT_ALL, MAX_SELECT_ALL));
  return getCardIdsForFilter(filter, capped);
}
