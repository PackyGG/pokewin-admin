import "server-only";

/**
 * Generalized "account wipe" snapshot store — the recovery copy for the
 * NEW wipe targets added alongside the existing "content balance
 * adjustments" wipe (src/lib/balance-adjustment-wipes):
 *
 *   - "balance"   → snapshot the user's available_balance (+ version), zero it.
 *   - "vault"     → snapshot the user's locked_balance (the vault) + unlock_at
 *                   (+ version), zero it.
 *   - "inventory" → snapshot the user's user_inventory rows, delete them.
 *   - "deposits"  → snapshot the user's `deposit` ledger rows + the
 *                   total_deposited counter delta, delete the rows + reduce
 *                   the counter. Restore re-inserts the rows + re-adds the
 *                   counter.
 *   - "wager"     → snapshot the user's GAMEPLAY: the wager + payout ledger
 *                   legs (pack/battle/upgrader bets + battle payout legs), the
 *                   won pack/battle `user_inventory` rows (+ their
 *                   `provably_fair_results` children), and the `upgrader_games`
 *                   rows; delete them all (FK-safe) and claw the credit legs
 *                   out of the balance (never inflate). Restore re-inserts
 *                   everything + re-adds the exact balance delta removed.
 *
 * Mirrors the snapshot-FIRST recovery model of commit f4bfca0 exactly: the
 * recovery copy is written to the admin DB and confirmed BEFORE the
 * destructive main-DB write. If the snapshot can't be written → abort
 * before touching the main DB (nothing changes). Once the destructive
 * main-DB tx commits the wipe is PERMANENT — Restore re-applies the
 * snapshot (re-credit balance / re-credit vault / re-insert inventory /
 * re-insert deposit rows) but there is no rollback path that re-creates
 * money/items if the snapshot itself was never written.
 *
 * Serialization mirrors src/lib/balance-adjustment-wipes/snapshot.ts and
 * src/lib/deleted-users/snapshot.ts (the canonical encoders):
 *   - Decimal (decimal.js) → canonical decimal string (Prisma accepts the
 *     string straight back for @db.Decimal columns on restore).
 *   - Date → ISO string (default JSON.stringify). Prisma accepts ISO
 *     strings for @db.Timestamp columns on the way back in.
 *   - BigInt → string (defensive; not used on the snapshotted models).
 */

/** The new wipe targets this store backs. Keyed in the DB column. */
export type AccountWipeType =
  | "balance"
  | "vault"
  | "inventory"
  | "deposits"
  | "wager";

export const ACCOUNT_WIPE_TYPES: readonly AccountWipeType[] = [
  "balance",
  "vault",
  "inventory",
  "deposits",
  "wager",
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

/**
 * Snapshot payload for a "deposits" wipe. Holds the FULL deleted `deposit`
 * ledger rows (JSON-safe) so Restore can re-insert each verbatim, plus the
 * exact amount the lifetime `total_deposited` counter was reduced by (so
 * Restore re-adds EXACTLY that — never more than was removed, even if other
 * deposits happened in between). `totalDepositedReduction` is the CLAMPED
 * amount actually subtracted (≤ the summed deposit amount), so re-adding it
 * is symmetric with the wipe.
 */
export type DepositsWipeSnapshot = {
  userId: string;
  /** Full deleted `deposit` ledger rows, Decimal/Date → canonical string. */
  rows: Array<Record<string, unknown>>;
  /** Summed amount of the deleted deposit rows (decimal string). */
  totalAmount: string;
  /** Amount actually subtracted from balances.total_deposited (clamped ≥0; decimal string). */
  totalDepositedReduction: string;
};

/**
 * Snapshot payload for a "wager" (gameplay) wipe. Holds every row the wipe
 * deletes so a restore can reconstruct the gameplay as faithfully as possible:
 *   - `ledgerRows`        — the deleted wager + payout ledger legs (pack/battle/
 *                           upgrader bets + battle payout legs), full rows.
 *   - `inventoryRows`     — the deleted won pack/battle `user_inventory` rows.
 *   - `provablyFairRows`  — the `provably_fair_results` children of the deleted
 *                           inventory rows (deleted FIRST so the inventory
 *                           delete doesn't cascade them silently; restored
 *                           before the inventory? no — restored AFTER, since PF
 *                           FK-references inventory; see the restore branch).
 *   - `upgraderGameRows`  — the deleted `upgrader_games` rows (generic records;
 *                           the table is not in the Prisma schema, so these are
 *                           read/written via raw SQL). Empty `[]` when the
 *                           connected DB lacks the table (the stale snapshot).
 *   - `balanceReduction`  — the EXACT amount subtracted from available_balance
 *                           = the credit (payout) legs' summed magnitude that
 *                           moved the balance UP, clamped so the balance never
 *                           went below 0. Restore re-adds EXACTLY this. Debit
 *                           (wager) legs are NOT restored to the balance — they
 *                           moved it DOWN and deleting them must not re-add the
 *                           wagered money (BALANCE RULE — never inflate).
 *   - `totalWageredReduction` — the EXACT amount subtracted from the lifetime
 *                           `balances.total_wagered` counter = Σ deleted
 *                           wager-leg magnitudes, clamped so the counter never
 *                           went below 0. Restore re-adds EXACTLY this.
 *   - `totalWonReduction` — the EXACT amount subtracted from the lifetime
 *                           `balances.total_won` counter = Σ deleted payout-leg
 *                           magnitudes + Σ deleted won-inventory
 *                           `value_at_obtained`, clamped so the counter never
 *                           went below 0. Restore re-adds EXACTLY this.
 *
 * COUNTER NOTE (the `total_wagered` / `total_won` decrement is an
 * APPROXIMATION of the production composition, mandated by the owner):
 * `balances.total_wagered` / `total_won` are lifetime counters MAINTAINED BY
 * THE PRODUCTION SITE (this admin panel only reads them — they back the
 * /users/[id] Total Wagered / Total Won / Wager Loss tiles AND the cost-
 * breakdown "Who drove the gaming margin" contributors). The exact rows the
 * site increments each counter by are NOT derivable from this codebase, so
 * the wipe decrements by what it DELETED: `total_wagered` by the wager
 * (debit) legs' summed magnitude, and `total_won` by the payout (credit)
 * legs' summed magnitude PLUS the won pack/battle inventory `value_at_obtained`
 * (the gaming-payout legs that DON'T move the balance). Both are clamped ≥0
 * (the stored reduction is the clamped amount actually subtracted, so wipe and
 * restore are symmetric even when a counter held less than the deleted sum).
 * A full wager wipe removes effectively all of a user's gameplay, so both
 * counters land at ~0 — which is the goal (the user drops off the contributors).
 *
 * BALANCE RULE detail (mirrors the adjustments wipe): a payout leg (battle_refund
 * / battle_excess_to_voucher / upgrader_payout) is a CREDIT — it raised the
 * balance — so deleting it claws that back (balance −= magnitude, clamp ≥0). A
 * wager leg (pack_opening / battle_bet / battle_sponsorship / upgrader_bet) is a
 * DEBIT — it lowered the balance — so deleting it leaves the balance UNCHANGED
 * (we do NOT give the stake back). Net balance reduction = Σ payout magnitudes,
 * clamped; never raises the balance.
 */
export type WagerWipeSnapshot = {
  userId: string;
  ledgerRows: Array<Record<string, unknown>>;
  inventoryRows: Array<Record<string, unknown>>;
  provablyFairRows: Array<Record<string, unknown>>;
  upgraderGameRows: Array<Record<string, unknown>>;
  /** Exact amount removed from available_balance (decimal string; ≥ 0). */
  balanceReduction: string;
  /** Exact amount subtracted from balances.total_wagered (clamped ≥0; decimal string). */
  totalWageredReduction: string;
  /** Exact amount subtracted from balances.total_won (clamped ≥0; decimal string). */
  totalWonReduction: string;
  /**
   * The recent WINDOW this wipe was bounded to (owner's heavy-account timeout
   * fix): `null` = "All" (the prior full-wipe behaviour, no lower time bound);
   * a number = the bounded look-back in hours (12 / 24 / 48). The snapshot ONLY
   * holds the windowed rows, so restore re-inserts exactly the windowed set.
   * Informational for the audit/restore record — the rows/decimals above are
   * the authoritative content. OPTIONAL for back-compat: snapshots written
   * before this field exists are read as `undefined` (treated as "All").
   */
  windowHours?: number | null;
  /** ISO cutoff the window resolved to (rows with ts ≥ this), or null for "All". Informational. */
  windowCutoff?: string | null;
};

export type AccountWipeSnapshot =
  | ({ type: "balance" } & BalanceWipeSnapshot)
  | ({ type: "vault" } & VaultWipeSnapshot)
  | ({ type: "inventory" } & InventoryWipeSnapshot)
  | ({ type: "deposits" } & DepositsWipeSnapshot)
  | ({ type: "wager" } & WagerWipeSnapshot);

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
