/**
 * Pure snapshot-restore partition for `revertPackToSnapshot` (packs/actions.ts).
 *
 * WHY THIS EXISTS (owner rule, 2026-07-03 — cap removals): a retune push now
 * truly REMOVES over-cap cards from `pack_cards` (the cap pre-filter's weight-0
 * verdict is persisted as an omitted row, not a dead 0% row). The History
 * snapshot captured BEFORE that push is the recovery path — so the revert MUST
 * be able to re-create a card that is no longer in the live pool. The old
 * revert filtered restorable cards by LIVE-POOL membership ("never re-insert a
 * card into a pool it left"), which would have silently skipped exactly the
 * card the owner is trying to bring back.
 *
 * The correct existence check is the CARDS CATALOG (the `pack_cards.card_id`
 * FK target): a snapshot card is restorable iff
 *   • its card still exists in `cards` (otherwise the createMany would violate
 *     the FK — skipped + reported, never guessed), AND
 *   • its captured weight is positive (legacy snapshots may carry weight-0
 *     rows from the pre-fix era; re-writing one would violate the "no MAIN
 *     write ever persists a weight ≤ 0 pack_cards row" rule — odds-identical
 *     to omission, skipped + reported for honesty).
 *
 * Pure + dependency-free so the `packs/__checks__/` harness can pin that a
 * cap-removed card (absent from the live pool, present in the catalog) IS
 * restored by a revert.
 */

export type SnapshotRestorePartition<T> = {
  /** Snapshot cards the revert re-creates (FK-safe, positive weight). */
  restorable: T[];
  /** Card ids the revert skips (reported, never silently dropped). */
  skippedCardIds: string[];
};

export function partitionSnapshotRestore<
  T extends { card_id: string; weight: number },
>(
  snapshotCards: readonly T[],
  /** Ids that still exist in the `cards` catalog (fresh MAIN read). */
  existingCardIds: ReadonlySet<string>,
): SnapshotRestorePartition<T> {
  const restorable: T[] = [];
  const skippedCardIds: string[] = [];
  for (const c of snapshotCards) {
    if (
      existingCardIds.has(c.card_id) &&
      Number.isFinite(c.weight) &&
      c.weight > 0
    ) {
      restorable.push(c);
    } else {
      skippedCardIds.push(c.card_id);
    }
  }
  return { restorable, skippedCardIds };
}
