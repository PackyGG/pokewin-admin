import "server-only";

/**
 * Generalized "account wipe" snapshot store — the recovery copy for the
 * three NEW wipe targets added alongside the existing "content balance
 * adjustments" wipe (src/lib/balance-adjustment-wipes):
 *
 *   - "balance"   → snapshot the user's available_balance (+ version), zero it.
 *   - "vault"     → snapshot the user's locked_balance (the vault) + unlock_at
 *                   (+ version), zero it.
 *   - "inventory" → snapshot the user's user_inventory rows, delete them.
 *
 * Mirrors the snapshot-FIRST recovery model of commit f4bfca0 exactly: the
 * recovery copy is written to the admin DB and confirmed BEFORE the
 * destructive main-DB write. If the snapshot can't be written → abort
 * before touching the main DB (nothing changes). Once the destructive
 * main-DB tx commits the wipe is PERMANENT — Restore re-applies the
 * snapshot (re-credit balance / re-credit vault / re-insert inventory) but
 * there is no rollback path that re-creates money/items if the snapshot
 * itself was never written.
 *
 * Serialization mirrors src/lib/balance-adjustment-wipes/snapshot.ts and
 * src/lib/deleted-users/snapshot.ts (the canonical encoders):
 *   - Decimal (decimal.js) → canonical decimal string (Prisma accepts the
 *     string straight back for @db.Decimal columns on restore).
 *   - Date → ISO string (default JSON.stringify). Prisma accepts ISO
 *     strings for @db.Timestamp columns on the way back in.
 *   - BigInt → string (defensive; not used on the snapshotted models).
 */

/** The three new wipe targets this store backs. Keyed in the DB column. */
export type AccountWipeType = "balance" | "vault" | "inventory";

export const ACCOUNT_WIPE_TYPES: readonly AccountWipeType[] = [
  "balance",
  "vault",
  "inventory",
] as const;

export function isAccountWipeType(v: unknown): v is AccountWipeType {
  return (
    typeof v === "string" &&
    (ACCOUNT_WIPE_TYPES as readonly string[]).includes(v)
  );
}

/**
 * Snapshot payload for a "balance" wipe. We record the version the wipe
 * optimistic-locked on so a restore can reason about the value the wipe
 * acted on; the live restore re-reads the current row + version though, so
 * `version` here is informational (the recorded balance_before is what
 * Restore re-adds, clamped against the live row).
 */
export type BalanceWipeSnapshot = {
  userId: string;
  /** available_balance immediately before the wipe (decimal string). */
  availableBalanceBefore: string;
  /** balances.version captured at snapshot time (optimistic-lock token). */
  version: number;
};

/**
 * Snapshot payload for a "vault" wipe. Vault on the platform =
 * `balances.locked_balance` (+ the optional `unlock_at` window). We capture
 * both so Restore can put the locked pool AND its unlock window back exactly
 * as they were.
 */
export type VaultWipeSnapshot = {
  userId: string;
  /** locked_balance (the vault pool) immediately before the wipe. */
  lockedBalanceBefore: string;
  /** unlock_at window before the wipe (ISO string) or null. */
  unlockAtBefore: string | null;
  /** balances.version captured at snapshot time. */
  version: number;
};

/**
 * Snapshot payload for an "inventory" wipe. Holds the FULL deleted
 * user_inventory rows (JSON-safe) so Restore can re-insert each verbatim
 * via the Unchecked create-input variant, exactly like the deleted-users
 * and adjustments-wipe restores.
 */
export type InventoryWipeSnapshot = {
  userId: string;
  /** Full deleted user_inventory rows, Decimal/Date → canonical string. */
  rows: Array<Record<string, unknown>>;
};

export type AccountWipeSnapshot =
  | ({ type: "balance" } & BalanceWipeSnapshot)
  | ({ type: "vault" } & VaultWipeSnapshot)
  | ({ type: "inventory" } & InventoryWipeSnapshot);

/**
 * JSON.stringify replacer that keeps Decimal.js / BigInt values addressable
 * after a JSON round-trip. Lifted verbatim from
 * src/lib/balance-adjustment-wipes/snapshot.ts so every snapshot store
 * encodes money the exact same way (Decimal → canonical string).
 */
export function accountWipeJsonReplacer(_key: string, value: unknown): unknown {
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
    return (value as { toFixed: () => string }).toFixed();
  }
  return value;
}

/**
 * Round-trip the snapshot through the replacer so it's JSON-safe (Decimal →
 * string, BigInt → string, Date → ISO string) and ready to hand straight to
 * `adminDb.admin_account_wipes.create({ data: { snapshot } })`.
 */
export function accountWipeSnapshotToJsonValue(
  snapshot: AccountWipeSnapshot,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(snapshot, accountWipeJsonReplacer),
  ) as Record<string, unknown>;
}
