"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { toNumber } from "@/lib/utils/decimal";
import type { Prisma } from "@/generated/prisma/client";
import { ensureAccountWipesSchema } from "@/lib/account-wipes/ensure-schema";
import { invalidateMetricCaches } from "@/lib/account-wipes/invalidate-metric-caches";
import {
  accountWipeSnapshotToJsonValue,
  type AccountWipeType,
  type AccountWipeSnapshot,
  type BalanceWipeSnapshot,
  type VaultWipeSnapshot,
  type InventoryWipeSnapshot,
} from "@/lib/account-wipes/snapshot";

// ───────────────────────────────────────────────────────────────────────────
// PROTECTED-DATA NOTE (creator deals + real finance) — see
// src/lib/account-wipes/protected.ts for the full, shared definition.
//
//  • BALANCE / VAULT wipes zero a FUNGIBLE pool (`available_balance` /
//    `locked_balance`). There is no per-dollar tag, so if a creator-deal
//    payout has been redeemed/converted into spendable or locked balance it
//    is part of that pool and WOULD be included. The model does not tag deal
//    balance separately, so per the task we DISCLOSE this in the preview
//    (`dealBalanceDisclosure` below) rather than silently separating it.
//
//  • INVENTORY wipe deletes `user_inventory` rows. `user_inventory.source_type`
//    is the enum { pack, reward, battle, exchange, raffle, upgrader } — there
//    is NO creator-deal source. Creator-deal payouts materialize as VOUCHERS
//    (`voucher_origin` includes creator_fill_conversion / creator_multiplier_
//    payout), never as inventory rows, and this wipe never touches the
//    `vouchers` table. So inventory is purely the user's own won/granted
//    cards — there is no creator-deal item subset to exclude. The preview
//    surfaces the per-source breakdown so the admin can see exactly that.
//
//  • The ADJUSTMENTS wipe (separate file) is the only mode that deletes
//    ledger rows; its protected-type + creator-deal guards live there.
// ───────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Generalized account-wipe targets — three NEW recoverable wipes that sit
// alongside the existing "content balance adjustments" wipe
// (wipe-adjustments-actions.ts). Each one mirrors commit f4bfca0 exactly:
//
//   SNAPSHOT-FIRST → main-DB destructive tx → audit → recoverable Restore.
//
// 1. WIPE BALANCE   — zero `balances.available_balance` (snapshot the value
//                     + version first; restore sets it back). Pure
//                     snapshot+reset, NO ledger row — same precedent as the
//                     adjustments wipe (it hard-deletes/zeroes and corrects
//                     the current balance without rewriting ledger history).
// 2. WIPE VAULT     — zero `balances.locked_balance` (the vault) and clear
//                     `unlock_at`. Snapshot both + version first; restore
//                     puts the locked pool AND its unlock window back.
// 3. WIPE INVENTORY — hard-delete the user's `user_inventory` rows. Snapshot
//                     the full rows first; restore re-inserts them verbatim.
//
// ORDERING (CRITICAL, snapshot-first): the recovery snapshot is written to
// the admin DB and confirmed BEFORE the destructive main-DB write. If the
// snapshot can't be written → abort before mutating anything (nothing
// changes). Once the destructive tx commits the wipe is PERMANENT — there
// is no rollback path that re-creates money/items if the snapshot itself
// was never written (matches f4bfca0). If the main-DB tx fails AFTER the
// snapshot was written, the orphan snapshot is deleted (nothing changed, so
// the recovery copy is unused) so it can't surface as a phantom restorable.
//
// DUAL-DB (strict): every destructive read/write is on the main `db`
// (balances / user_inventory). Every snapshot read/write is on `adminDb`
// (admin_account_wipes). No cross-DB joins.
//
// GATING (same as the adjustments wipe + full account wipe): requireAdmin +
// __can_wipe_accounts + 2FA, with a preview+confirm dialog upstream and a
// hard server-side ownership re-check on every row.
// ---------------------------------------------------------------------------

/**
 * Shared gate for every action in this file. Identical to the adjustments
 * wipe + the full `wipeUserAccount` gate — these are destructive money/item
 * operations, so they get the strongest gate on the page. Returns the
 * session.
 */
async function gateWipe() {
  const session = await requireAdmin();
  await requireCapability(session, "__can_wipe_accounts", "wipe account data");
  return session;
}

const userIdSchema = z.string().min(1, "User id is required");

// ───────────────────────────────────────────────────────────────────────────
// Preview reads — lazy, called by each dialog when it OPENS (hidden-component
// rule: never preloaded on page render). Read-only.
// ───────────────────────────────────────────────────────────────────────────

export type BalanceWipePreview = {
  availableBalance: number;
  /**
   * True when there is a non-zero fungible balance that will be zeroed. The
   * dialog uses this to show the "any creator-deal balance sitting in
   * spendable balance is INCLUDED (fungible — can't be separated)"
   * disclosure before approval (Task 2 / protected.ts note).
   */
  dealBalanceDisclosure: boolean;
};

export type VaultWipePreview = {
  lockedBalance: number;
  unlockAt: string | null;
  /** Same fungible-balance disclosure flag as balance, for the vault pool. */
  dealBalanceDisclosure: boolean;
};

/** One row of the inventory source breakdown shown in the preview. */
export type InventorySourceBreakdown = {
  source: string;
  count: number;
  value: number;
};

export type InventoryWipePreview = {
  itemCount: number;
  totalValue: number;
  /**
   * Per-`source_type` breakdown of the rows that will be deleted. Lets the
   * admin see EXACTLY what is being removed and confirms there is no
   * creator-deal source in inventory (deal payouts are vouchers, never
   * inventory) — every row is a won/granted card (pack/battle/reward/…).
   */
  bySource: InventorySourceBreakdown[];
};

/** Current spendable balance the "wipe balance" action would zero. */
export async function previewBalanceWipe(
  userId: string,
): Promise<{ success: true; preview: BalanceWipePreview } | { success: false; error: string }> {
  await gateWipe();
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid user id" };
  }
  const db = await getDb();
  const b = await db.balances.findUnique({
    where: { user_id: parsed.data },
    select: { available_balance: true },
  });
  if (!b) return { success: false, error: "User balances not found" };
  const availableBalance = toNumber(b.available_balance);
  return {
    success: true,
    preview: { availableBalance, dealBalanceDisclosure: availableBalance > 0 },
  };
}

/** Current vault (locked_balance) + unlock window the "wipe vault" action would clear. */
export async function previewVaultWipe(
  userId: string,
): Promise<{ success: true; preview: VaultWipePreview } | { success: false; error: string }> {
  await gateWipe();
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid user id" };
  }
  const db = await getDb();
  const b = await db.balances.findUnique({
    where: { user_id: parsed.data },
    select: { locked_balance: true, unlock_at: true },
  });
  if (!b) return { success: false, error: "User balances not found" };
  const lockedBalance = toNumber(b.locked_balance);
  return {
    success: true,
    preview: {
      lockedBalance,
      unlockAt: b.unlock_at?.toISOString() ?? null,
      dealBalanceDisclosure: lockedBalance > 0,
    },
  };
}

/**
 * Count + summed value_at_obtained of the user_inventory rows the wipe would
 * delete, plus a per-source breakdown. The breakdown is itemized for the
 * pre-approval preview and confirms the inventory holds only won/granted
 * cards (source_type ∈ pack/battle/reward/exchange/raffle/upgrader) — there
 * is no creator-deal source, so nothing protected is in inventory.
 */
export async function previewInventoryWipe(
  userId: string,
): Promise<{ success: true; preview: InventoryWipePreview } | { success: false; error: string }> {
  await gateWipe();
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid user id" };
  }
  const db = await getDb();
  const grouped = await db.user_inventory.groupBy({
    by: ["source_type"],
    where: { user_id: parsed.data },
    _count: { _all: true },
    _sum: { value_at_obtained: true },
  });

  let itemCount = 0;
  let totalValue = 0;
  const bySource: InventorySourceBreakdown[] = [];
  for (const g of grouped) {
    const count = g._count._all;
    const value = toNumber(g._sum.value_at_obtained);
    itemCount += count;
    totalValue += value;
    bySource.push({ source: String(g.source_type), count, value });
  }
  // Newest/largest groups first so the preview reads cleanly.
  bySource.sort((a, b) => b.count - a.count);

  return {
    success: true,
    preview: { itemCount, totalValue, bySource },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. WIPE BALANCE — snapshot available_balance + version, then set it to 0.
// ───────────────────────────────────────────────────────────────────────────

const wipeBalanceSchema = z.object({
  userId: z.string().min(1, "User id is required"),
  totpCode: z.string().min(1, "2FA code is required"),
});

/**
 * Zero the user's spendable balance. Snapshot-first (records
 * available_balance + the optimistic-lock version into admin_account_wipes),
 * then a main-DB tx sets available_balance to 0 under that version lock.
 *
 * NOTE on the ledger: like the adjustments wipe, this is a snapshot+reset —
 * it does NOT write a ledger_transactions row. Wiping a content account's
 * spendable balance is a deliberate clawback of house-granted balance, not a
 * user-facing financial event; the recovery snapshot + audit event are the
 * authoritative trail, and Restore puts the exact amount back. The
 * remaining ledger rows' balance_before/after are intentionally not
 * rewritten (same fidelity tradeoff the adjustments wipe documents).
 */
export async function wipeBalance(data: {
  userId: string;
  totpCode: string;
}): Promise<
  | { success: true; amountRemoved: number; balanceBefore: number }
  | { success: false; error: string }
> {
  const session = await gateWipe();

  const parseResult = wipeBalanceSchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  try {
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  // Provision the recovery store before touching the main DB. A failure
  // here aborts before any destructive write.
  try {
    await ensureAccountWipesSchema();
  } catch (err) {
    console.error("[wipeBalance] ensure-schema failed:", err);
    return {
      success: false,
      error: "Could not prepare the recovery store — wipe aborted (nothing changed)",
    };
  }

  const db = await getDb();

  // Read the balance + capture the version we'll optimistic-lock on.
  const pre = await db.balances
    .findUnique({ where: { user_id: parsed.userId } })
    .catch(() => null);
  if (!pre) return { success: false, error: "User balances not found" };

  const balanceBefore = toNumber(pre.available_balance);
  const lockVersion = pre.version;
  if (balanceBefore <= 0) {
    return { success: false, error: "Available balance is already $0 — nothing to wipe" };
  }

  const userMeta = await db.user
    .findUnique({ where: { id: parsed.userId }, select: { username: true, email: true } })
    .catch(() => null);

  // SNAPSHOT FIRST — write the recovery copy and capture its id. If this
  // throws the function returns here: nothing in the main DB has changed.
  const snapshot: AccountWipeSnapshot = {
    type: "balance",
    userId: parsed.userId,
    availableBalanceBefore: balanceBefore.toFixed(2),
    version: lockVersion,
  } satisfies { type: "balance" } & BalanceWipeSnapshot;

  let wipeId: string;
  try {
    const created = await adminDb.admin_account_wipes.create({
      data: {
        wipe_type: "balance",
        user_id: parsed.userId,
        username: userMeta?.username ?? null,
        email: userMeta?.email ?? null,
        wiped_by: session.userId,
        amount: balanceBefore,
        item_count: 0,
        snapshot: accountWipeSnapshotToJsonValue(snapshot) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    wipeId = created.id;
  } catch (snapErr) {
    console.error("[wipeBalance] snapshot write failed — wipe aborted (nothing changed):", snapErr);
    return {
      success: false,
      error: "Could not write the recovery snapshot — wipe aborted (nothing changed)",
    };
  }

  // DESTRUCTIVE — zero available_balance under the captured version lock.
  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.balances.updateMany({
        where: { user_id: parsed.userId, version: lockVersion },
        data: { available_balance: 0, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }
    });
  } catch (err) {
    // Main-DB tx failed → nothing changed. Delete the orphan snapshot so it
    // can't surface as a phantom restorable (restoring it would credit money
    // that was never removed). Best-effort; log loudly if cleanup fails.
    await adminDb.admin_account_wipes.delete({ where: { id: wipeId } }).catch((cleanupErr) => {
      console.error(
        "[wipeBalance] CRITICAL: main-DB wipe failed AND orphan snapshot cleanup failed — snapshot",
        wipeId,
        "is orphaned (balance never zeroed; do NOT restore it):",
        cleanupErr,
      );
    });
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("concurrently")) return { success: false, error: message };
    console.error("[wipeBalance] zero-balance transaction failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing changed)" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_balance_wiped",
    targetUserId: parsed.userId,
    metadata: {
      wipeId,
      amountRemoved: balanceBefore,
      balanceBefore,
      balanceAfter: 0,
      recoverable: true,
      note: "snapshot+reset (no ledger row); remaining ledger balance_before/after not rewritten",
    },
  });

  // Refresh the user page AND bust the global metric caches so the now-zeroed
  // balance drops out of the cached dashboard / P&L / analytics figures
  // immediately (the live balance pool feeds the P&L on-site term).
  revalidatePath(`/users/${parsed.userId}`);
  invalidateMetricCaches(parsed.userId);
  return { success: true, amountRemoved: balanceBefore, balanceBefore };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. WIPE VAULT — snapshot locked_balance + unlock_at + version, then zero both.
// ───────────────────────────────────────────────────────────────────────────

const wipeVaultSchema = z.object({
  userId: z.string().min(1, "User id is required"),
  totpCode: z.string().min(1, "2FA code is required"),
});

/**
 * Zero the user's vault (balances.locked_balance) and clear the unlock
 * window. Snapshot-first (records locked_balance + unlock_at + version),
 * then a main-DB tx zeroes locked_balance + nulls unlock_at under the
 * version lock. Restore re-credits the locked pool AND restores unlock_at.
 *
 * Like wipeBalance this is a snapshot+reset with NO ledger row — the vault
 * pool is house-controlled state; the recovery snapshot + audit event are
 * the authoritative trail.
 */
export async function wipeVault(data: {
  userId: string;
  totpCode: string;
}): Promise<
  | { success: true; amountRemoved: number; lockedBefore: number }
  | { success: false; error: string }
> {
  const session = await gateWipe();

  const parseResult = wipeVaultSchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  try {
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  try {
    await ensureAccountWipesSchema();
  } catch (err) {
    console.error("[wipeVault] ensure-schema failed:", err);
    return {
      success: false,
      error: "Could not prepare the recovery store — wipe aborted (nothing changed)",
    };
  }

  const db = await getDb();

  const pre = await db.balances
    .findUnique({ where: { user_id: parsed.userId } })
    .catch(() => null);
  if (!pre) return { success: false, error: "User balances not found" };

  const lockedBefore = toNumber(pre.locked_balance);
  const unlockAtBefore = pre.unlock_at?.toISOString() ?? null;
  const lockVersion = pre.version;
  if (lockedBefore <= 0) {
    return { success: false, error: "Vault (locked balance) is already $0 — nothing to wipe" };
  }

  const userMeta = await db.user
    .findUnique({ where: { id: parsed.userId }, select: { username: true, email: true } })
    .catch(() => null);

  const snapshot: AccountWipeSnapshot = {
    type: "vault",
    userId: parsed.userId,
    lockedBalanceBefore: lockedBefore.toFixed(2),
    unlockAtBefore,
    version: lockVersion,
  } satisfies { type: "vault" } & VaultWipeSnapshot;

  let wipeId: string;
  try {
    const created = await adminDb.admin_account_wipes.create({
      data: {
        wipe_type: "vault",
        user_id: parsed.userId,
        username: userMeta?.username ?? null,
        email: userMeta?.email ?? null,
        wiped_by: session.userId,
        amount: lockedBefore,
        item_count: 0,
        snapshot: accountWipeSnapshotToJsonValue(snapshot) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    wipeId = created.id;
  } catch (snapErr) {
    console.error("[wipeVault] snapshot write failed — wipe aborted (nothing changed):", snapErr);
    return {
      success: false,
      error: "Could not write the recovery snapshot — wipe aborted (nothing changed)",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.balances.updateMany({
        where: { user_id: parsed.userId, version: lockVersion },
        data: { locked_balance: 0, unlock_at: null, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }
    });
  } catch (err) {
    await adminDb.admin_account_wipes.delete({ where: { id: wipeId } }).catch((cleanupErr) => {
      console.error(
        "[wipeVault] CRITICAL: main-DB wipe failed AND orphan snapshot cleanup failed — snapshot",
        wipeId,
        "is orphaned (vault never zeroed; do NOT restore it):",
        cleanupErr,
      );
    });
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("concurrently")) return { success: false, error: message };
    console.error("[wipeVault] zero-vault transaction failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing changed)" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_vault_wiped",
    targetUserId: parsed.userId,
    metadata: {
      wipeId,
      amountRemoved: lockedBefore,
      lockedBefore,
      unlockAtBefore,
      recoverable: true,
      note: "snapshot+reset (no ledger row); locked_balance zeroed + unlock_at cleared",
    },
  });

  // Refresh the user page AND bust the global metric caches so the zeroed
  // vault (locked_balance) drops out of the cached dashboard / P&L / analytics
  // figures immediately (locked_balance feeds the P&L on-site term).
  revalidatePath(`/users/${parsed.userId}`);
  invalidateMetricCaches(parsed.userId);
  return { success: true, amountRemoved: lockedBefore, lockedBefore };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. WIPE INVENTORY — snapshot user_inventory rows, then delete them.
// ───────────────────────────────────────────────────────────────────────────

const wipeInventorySchema = z.object({
  userId: z.string().min(1, "User id is required"),
  totpCode: z.string().min(1, "2FA code is required"),
});

// Sanity ceiling on the JSONB blob we persist. Mirrors the deleted-users
// snapshot cap so a user with a pathological inventory can't generate a
// multi-hundred-MB blob that stalls the admin DB. If a user's inventory
// exceeds this we refuse the wipe rather than truncate (a truncated
// snapshot is not fully recoverable, which would violate the safety
// contract — surface the count instead).
const MAX_INVENTORY_ROWS = 50_000;

/**
 * Hard-delete every `user_inventory` row owned by this user. Snapshot-first
 * (the FULL rows are written to admin_account_wipes), then a main-DB tx
 * deletes exactly this user's rows (and the `provably_fair_results` that FK
 * to them, which would otherwise block the delete). Restore re-inserts the
 * snapshotted rows verbatim.
 *
 * INVENTORY ↔ GGR NOTE (surfaced in the dialog + audit, metric logic NOT
 * changed here): `user_inventory.value_at_obtained` feeds the canonical
 * inventory-delta GGR payout leg (src/lib/queries/ggr.ts inv_leg). The GGR
 * customer scope KEEPS creators (`role NOT IN ('admin','support')`) and only
 * drops creator-on-session rows per-row — so a creator's OFF-SESSION
 * pack/battle inventory DOES count toward customer GGR. Deleting these rows
 * retroactively lowers historical GGR payout (GGR looks better for the
 * house). Restore puts the rows back and the metric self-corrects.
 */
export async function wipeInventory(data: {
  userId: string;
  totpCode: string;
}): Promise<
  | { success: true; deletedCount: number; totalValue: number }
  | { success: false; error: string }
> {
  const session = await gateWipe();

  const parseResult = wipeInventorySchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  try {
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  try {
    await ensureAccountWipesSchema();
  } catch (err) {
    console.error("[wipeInventory] ensure-schema failed:", err);
    return {
      success: false,
      error: "Could not prepare the recovery store — wipe aborted (nothing deleted)",
    };
  }

  const db = await getDb();

  // Read the FULL rows up front so the snapshot is exact. Scoped strictly to
  // this user. Bounded by MAX_INVENTORY_ROWS+1 so we can detect an
  // over-cap inventory without scanning unboundedly.
  const rows = await db.user_inventory.findMany({
    where: { user_id: parsed.userId },
    take: MAX_INVENTORY_ROWS + 1,
  });

  if (rows.length === 0) {
    return { success: false, error: "This user has no inventory to wipe" };
  }
  if (rows.length > MAX_INVENTORY_ROWS) {
    return {
      success: false,
      error: `Inventory too large to snapshot safely (> ${MAX_INVENTORY_ROWS.toLocaleString()} items) — wipe aborted`,
    };
  }

  const inventoryIds = rows.map((r) => r.id);
  const totalValue = rows.reduce((acc, r) => acc + toNumber(r.value_at_obtained), 0);

  // Per-source breakdown (from the rows we already read — no extra query) for
  // the audit trail. Confirms the deleted set is only won/granted cards
  // (source_type ∈ pack/battle/reward/exchange/raffle/upgrader); there is no
  // creator-deal source in inventory (deal payouts are vouchers).
  const countBySource: Record<string, number> = {};
  for (const r of rows) {
    const s = String(r.source_type);
    countBySource[s] = (countBySource[s] ?? 0) + 1;
  }

  const userMeta = await db.user
    .findUnique({ where: { id: parsed.userId }, select: { username: true, email: true } })
    .catch(() => null);

  // SNAPSHOT FIRST — write the full rows. Abort on failure (nothing deleted).
  const snapshot: AccountWipeSnapshot = {
    type: "inventory",
    userId: parsed.userId,
    rows: rows as unknown as Array<Record<string, unknown>>,
  } satisfies { type: "inventory" } & InventoryWipeSnapshot;

  let wipeId: string;
  try {
    const created = await adminDb.admin_account_wipes.create({
      data: {
        wipe_type: "inventory",
        user_id: parsed.userId,
        username: userMeta?.username ?? null,
        email: userMeta?.email ?? null,
        wiped_by: session.userId,
        amount: 0,
        item_count: rows.length,
        snapshot: accountWipeSnapshotToJsonValue(snapshot) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    wipeId = created.id;
  } catch (snapErr) {
    console.error("[wipeInventory] snapshot write failed — wipe aborted (nothing deleted):", snapErr);
    return {
      success: false,
      error: "Could not write the recovery snapshot — wipe aborted (nothing deleted)",
    };
  }

  // DESTRUCTIVE — delete the rows (+ their provably_fair_results children
  // which FK to user_inventory.id) scoped to THIS user. The delete is
  // re-scoped by user_id so it can't touch another user's rows even under a
  // race, and the count is verified.
  try {
    await db.$transaction(async (tx) => {
      // provably_fair_results.user_inventory_id → user_inventory.id. The full
      // account wipe deletes these via the inventory relation; we do the same
      // so the inventory deleteMany doesn't hit an FK constraint.
      await tx.provably_fair_results.deleteMany({
        where: { user_inventory: { user_id: parsed.userId } },
      });
      const del = await tx.user_inventory.deleteMany({
        where: { id: { in: inventoryIds }, user_id: parsed.userId },
      });
      if (del.count !== inventoryIds.length) {
        // A row was added/removed concurrently between the snapshot read and
        // the delete → abort so the snapshot and the actual delete agree.
        throw new Error("INV_GUARD: inventory changed concurrently — refresh and retry");
      }
    });
  } catch (err) {
    await adminDb.admin_account_wipes.delete({ where: { id: wipeId } }).catch((cleanupErr) => {
      console.error(
        "[wipeInventory] CRITICAL: main-DB wipe failed AND orphan snapshot cleanup failed — snapshot",
        wipeId,
        "is orphaned (inventory not deleted; do NOT restore it):",
        cleanupErr,
      );
    });
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.startsWith("INV_GUARD:")) {
      return { success: false, error: message.replace(/^INV_GUARD:\s*/, "") };
    }
    console.error("[wipeInventory] delete transaction failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing deleted)" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_inventory_wiped",
    targetUserId: parsed.userId,
    metadata: {
      wipeId,
      deletedCount: rows.length,
      totalValue,
      countBySource,
      recoverable: true,
      note: "user_inventory rows deleted (their provably_fair_results cascade-delete and are NOT re-created on restore — historical PF leaf data, same tradeoff as deleted-user restore); value_at_obtained feeds GGR inv-leg (restorable). Inventory has no creator-deal source — deal payouts are vouchers, not inventory, and are untouched.",
    },
  });

  // Refresh the user page AND bust the global metric caches. The deleted
  // rows' `value_at_obtained` feeds the canonical GGR inventory-payout leg
  // (ggr.ts inv_leg) + the P&L inventory term — both are live-computed from
  // user_inventory, so busting their caches makes the wipe count in the
  // dashboard / GGR / analytics figures immediately.
  revalidatePath(`/users/${parsed.userId}`);
  invalidateMetricCaches(parsed.userId);
  return { success: true, deletedCount: rows.length, totalValue };
}

// ───────────────────────────────────────────────────────────────────────────
// Listing + Restore — shared across all three new types + the audit log.
// ───────────────────────────────────────────────────────────────────────────

export type AccountWipeRecord = {
  id: string;
  wipeType: AccountWipeType;
  wipedAt: string;
  wipedByLabel: string;
  /** Money removed (balance/vault). 0 for inventory. */
  amount: number;
  /** Rows removed (inventory). 0 for balance/vault. */
  itemCount: number;
  restoredAt: string | null;
  restoredByLabel: string | null;
};

/**
 * List this user's account-wipe records (newest first) from the generalized
 * admin_account_wipes store, resolving admin display labels. Read-only.
 * (The legacy adjustments wipes live in their own table and are listed by
 * listBalanceAdjustmentWipes — the audit-log UI merges both.)
 */
export async function listAccountWipes(userId: string): Promise<AccountWipeRecord[]> {
  await gateWipe();

  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) return [];

  await ensureAccountWipesSchema();

  const wipes = await adminDb.admin_account_wipes.findMany({
    where: { user_id: parsed.data },
    orderBy: { wiped_at: "desc" },
    take: 50,
  });
  if (wipes.length === 0) return [];

  const adminIds = new Set<string>();
  for (const w of wipes) {
    adminIds.add(w.wiped_by);
    if (w.restored_by) adminIds.add(w.restored_by);
  }
  const admins = adminIds.size
    ? await adminDb.admin_users.findMany({
        where: { id: { in: Array.from(adminIds) } },
        select: { id: true, username: true, display_username: true },
      })
    : [];
  const labels = new Map(admins.map((a) => [a.id, a.display_username ?? a.username]));

  return wipes.map((w) => ({
    id: w.id,
    wipeType: (w.wipe_type as AccountWipeType),
    wipedAt: w.wiped_at.toISOString(),
    wipedByLabel: labels.get(w.wiped_by) ?? w.wiped_by,
    amount: toNumber(w.amount),
    itemCount: w.item_count,
    restoredAt: w.restored_at?.toISOString() ?? null,
    restoredByLabel: w.restored_by ? labels.get(w.restored_by) ?? w.restored_by : null,
  }));
}

const restoreSchema = z.object({
  wipeId: z.string().uuid("Invalid wipe id"),
  totpCode: z.string().min(1, "2FA code is required"),
});

/**
 * Restore an account-wipe record by re-applying its snapshot. Dispatches on
 * the record's wipe_type:
 *   - balance   → re-add availableBalanceBefore to available_balance.
 *   - vault     → re-add lockedBalanceBefore to locked_balance + restore unlock_at.
 *   - inventory → re-insert the snapshotted user_inventory rows.
 *
 * Idempotent-guarded: a record already marked restored_at cannot be restored
 * again (double-credit / double-insert). Balance/vault re-credits are
 * optimistic-locked against the LIVE row (not the stale wipe-time version) so
 * the restore is additive to whatever the balance is now.
 */
export async function restoreAccountWipe(
  wipeId: string,
  totpCode: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await gateWipe();

  const parsed = restoreSchema.safeParse({ wipeId, totpCode });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await require2FA(session.userId, parsed.data.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  await ensureAccountWipesSchema();

  const wipe = await adminDb.admin_account_wipes.findUnique({
    where: { id: parsed.data.wipeId },
  });
  if (!wipe) return { success: false, error: "Wipe record not found" };
  if (wipe.restored_at) return { success: false, error: "This wipe has already been restored" };

  const snapshot = wipe.snapshot as unknown as AccountWipeSnapshot;
  if (!snapshot || !snapshot.type || !snapshot.userId) {
    return { success: false, error: "Snapshot is malformed — cannot restore" };
  }

  const db = await getDb();

  try {
    if (snapshot.type === "balance") {
      const addBack = toNumber(snapshot.availableBalanceBefore);
      await db.$transaction(async (tx) => {
        const b = await tx.balances.findUnique({ where: { user_id: snapshot.userId } });
        if (!b) throw new Error("User balances not found");
        const updated = await tx.balances.updateMany({
          where: { user_id: snapshot.userId, version: b.version },
          data: {
            available_balance: toNumber(b.available_balance) + addBack,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new Error("Balance changed concurrently — please retry");
      });
    } else if (snapshot.type === "vault") {
      const addBack = toNumber(snapshot.lockedBalanceBefore);
      const restoreUnlockAt = snapshot.unlockAtBefore ? new Date(snapshot.unlockAtBefore) : null;
      await db.$transaction(async (tx) => {
        const b = await tx.balances.findUnique({ where: { user_id: snapshot.userId } });
        if (!b) throw new Error("User balances not found");
        const updated = await tx.balances.updateMany({
          where: { user_id: snapshot.userId, version: b.version },
          data: {
            locked_balance: toNumber(b.locked_balance) + addBack,
            // Restore the captured unlock window. If the vault has since been
            // re-locked with a different window this overwrites it back to the
            // pre-wipe value — the snapshot is the source of truth for what we
            // removed.
            unlock_at: restoreUnlockAt,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new Error("Balance changed concurrently — please retry");
      });
    } else if (snapshot.type === "inventory") {
      if (!Array.isArray(snapshot.rows)) {
        return { success: false, error: "Snapshot is malformed — cannot restore" };
      }
      const rowsForInsert = snapshot.rows.map((r) => {
        const copy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (v === undefined) continue;
          copy[k] = v;
        }
        return copy;
      });
      await db.$transaction(async (tx) => {
        // skipDuplicates makes a retried restore (e.g. after a timeout) safe.
        await tx.user_inventory.createMany({
          data: rowsForInsert as unknown as Prisma.user_inventoryCreateManyInput[],
          skipDuplicates: true,
        });
      });
    } else {
      return { success: false, error: "Unknown wipe type — cannot restore" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message === "User balances not found" || message.includes("concurrently")) {
      return { success: false, error: message };
    }
    console.error("[restoreAccountWipe] transaction failed:", err);
    return { success: false, error: "Restore failed — please try again" };
  }

  await adminDb.admin_account_wipes.update({
    where: { id: parsed.data.wipeId },
    data: { restored_at: new Date(), restored_by: session.userId },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_account_wipe_restored",
    targetUserId: snapshot.userId,
    metadata: {
      wipeId: parsed.data.wipeId,
      wipeType: snapshot.type,
      amount: toNumber(wipe.amount),
      itemCount: wipe.item_count,
    },
  });

  // Restore re-adds the balance / vault / inventory rows, so the global metric
  // caches must be busted too — the restored value re-enters GGR / P&L /
  // analytics, the exact reverse of the wipe.
  revalidatePath(`/users/${snapshot.userId}`);
  invalidateMetricCaches(snapshot.userId);
  return { success: true };
}
