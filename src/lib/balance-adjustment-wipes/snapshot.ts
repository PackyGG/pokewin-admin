import "server-only";

/**
 * Snapshot shape persisted into admin_balance_adjustment_wipes.snapshot.
 *
 * The wipe flow hard-deletes selected `admin_balance_adjustment` ledger
 * rows from the main DB and snapshots their FULL row data here first so the
 * batch is recoverable. Restore re-inserts each row verbatim (Unchecked
 * create-input) and re-adds the summed amount back to the balance.
 *
 * Serialization mirrors src/lib/deleted-users/snapshot.ts:
 *   - Decimal (decimal.js) → canonical decimal string (so restore can hand
 *     it straight back to Prisma, which accepts string for @db.Decimal).
 *   - Date → ISO string (default JSON.stringify). Prisma accepts ISO
 *     strings for @db.Timestamp columns on the way back in.
 *   - BigInt → string (defensive; not used on ledger_transactions).
 */
export type BalanceAdjustmentWipeSnapshot = {
  /** Main-DB user id the rows belong to — re-verified on restore. */
  userId: string;
  /**
   * Full deleted ledger_transactions rows (JSON-safe). Each is restored
   * via tx.ledger_transactions.create with the Unchecked input variant.
   */
  rows: Array<Record<string, unknown>>;
};

/**
 * JSON.stringify replacer that keeps Decimal.js / BigInt values addressable
 * after a JSON round-trip. Prisma returns Decimal via `decimal.js` —
 * instances expose `toFixed()`; without this they'd serialize as
 * `{ s, e, d }` (Decimal's internal shape) which restore can't parse.
 * Lifted from src/lib/deleted-users/snapshot.ts so the two snapshot stores
 * encode money the exact same way.
 */
export function wipeSnapshotJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (
    value !== null &&
    typeof value === "object" &&
    "toFixed" in value &&
    typeof (value as { toFixed: unknown }).toFixed === "function" &&
    "s" in value &&
    "e" in value &&
    "d" in value
  ) {
    // decimal.js Decimal instance — render the canonical decimal string.
    return (value as { toFixed: () => string }).toFixed();
  }
  return value;
}

/**
 * Convert the snapshot to a `Prisma.InputJsonValue`-compatible structure by
 * round-tripping through the replacer. The result is JSON-safe (Decimal →
 * string, BigInt → string, Date → ISO string) and ready to hand directly to
 * `adminDb.admin_balance_adjustment_wipes.create({ data: { snapshot } })`.
 */
export function wipeSnapshotToJsonValue(
  snapshot: BalanceAdjustmentWipeSnapshot,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(snapshot, wipeSnapshotJsonReplacer),
  ) as Record<string, unknown>;
}
