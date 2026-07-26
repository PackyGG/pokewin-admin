export type OrderedBatchResult = {
  committed: number;
  deadLettered: number;
};

/**
 * Expensive preparation may run concurrently, but ordered persistence remains
 * sequential so each item can atomically move the durable cursor. A poison
 * item is retained by `deadLetter` and does not block later siblings.
 */
export async function processOrderedBatch<Item, Prepared>(
  items: readonly Item[],
  prepare: (item: Item) => Promise<Prepared>,
  commit: (item: Item, prepared: Prepared) => Promise<void>,
  deadLetter: (item: Item, error: unknown) => Promise<void>,
): Promise<OrderedBatchResult> {
  const prepared = await Promise.allSettled(items.map(prepare));
  let committed = 0;
  let deadLettered = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const result = prepared[index];
    if (item === undefined || result === undefined) continue;

    if (result.status === "rejected") {
      await deadLetter(item, result.reason);
      deadLettered += 1;
      continue;
    }

    try {
      await commit(item, result.value);
      committed += 1;
    } catch (error) {
      await deadLetter(item, error);
      deadLettered += 1;
    }
  }

  return { committed, deadLettered };
}
