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
  WIPE_STATUS,
  finalizeWipeSuccess,
  markWipeFailed,
  resolveRequestIp,
  type WipeStatus,
} from "@/lib/account-wipes/finalize";
import {
  accountWipeSnapshotToJsonValue,
  type AccountWipeType,
  type AccountWipeSnapshot,
  type BalanceWipeSnapshot,
  type VaultWipeSnapshot,
  type InventoryWipeSnapshot,
} from "@/lib/account-wipes/snapshot";
// NOTE: the `deposits` + `wager` snapshot types' restore branches are handled
// below; both are part of the AccountWipeSnapshot union so no extra import is
// needed.

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
//    ledger rows; its protected-type + creator-deal + affiliate guards live
//    there.
//
//  • AFFILIATE TABLES ARE NEVER TOUCHED (owner mandate — no affiliate info of
//    any kind is ever wiped). The three modes in THIS file write only
//    `balances` (available/locked) and `user_inventory` (+ its
//    `provably_fair_results` children); the adjustments mode writes only
//    `ledger_transactions`. NONE of `affiliate_accounts`,
//    `affiliate_code_usages`, `affiliate_codes`, `affiliate_payouts`,
//    `affiliate_clicks`, or `affiliate_code_queue` is read or written by any
//    wipe. So affiliate accounts (earned / available / paid-out totals),
//    every code-usage attribution row (commissions owed + referral linkage),
//    the affiliate code itself, and the payout history are STRUCTURALLY
//    untouched. Deleting from those tables is OUT OF SCOPE and must never be
//    added here. See WIPE_NEVER_TOUCHES_AFFILIATE_TABLES in
//    src/lib/account-wipes/protected.ts and the rolled-back proof in
//    scripts/verify-affiliate-wipe-protection.ts.
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
// 3. WIPE INVENTORY — hard-delete the user's CURRENTLY-HELD `user_inventory`
//                     rows (sold/exchanged/withdrawal-locked rows are left as
//                     historical record — see HELD_INVENTORY_FILTER). Snapshot
//                     the held rows first; restore re-inserts them verbatim.
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

/** A single high-value item shown in the "top items" preview list. */
export type InventoryTopItem = {
  /** user_inventory.id (stable key; not shown). */
  id: string;
  /** Resolved card name (falls back to "Unknown card" if the card row is gone). */
  name: string;
  /** value_at_obtained for this row. */
  value: number;
};

/** One value-tier bucket: how many items fall in [min, max) and their summed value. */
export type InventoryValueTier = {
  /** Stable key / label id for the tier (e.g. "100+"). */
  label: string;
  /** Inclusive lower bound (USD). */
  min: number;
  /** Exclusive upper bound (USD), or null for the open-ended top tier. */
  max: number | null;
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
  /**
   * The highest-value items (top ≤10 by value_at_obtained, resolved to card
   * names) so the admin sees WHAT the headline value actually is — e.g. that
   * $38k is one $30k card + a long tail, not thousands of cheap commons —
   * before the 2FA approve. Derived from a single bounded orderBy query.
   */
  topItems: InventoryTopItem[];
  /**
   * Value-tier distribution (count + summed value per price band) over ALL
   * rows being deleted, so the admin sees the shape of the wipe (how many
   * high-value vs cheap items). Buckets are fixed bands aggregated per-user.
   * Only non-empty tiers are returned.
   */
  valueTiers: InventoryValueTier[];
};

// Fixed value-tier bands (USD) for the inventory wipe preview distribution.
// Ascending, contiguous, half-open [min, max). The top band is open-ended
// (max = null). Chosen to span the realistic card-value range (cents → $1k+)
// so a $38k inventory's shape (e.g. mostly one big card vs a long cheap tail)
// is legible. Aggregated per-user (the `user_id`-indexed row set is small),
// so the fixed handful of per-tier aggregates is cheap.
const INVENTORY_VALUE_TIER_BANDS: ReadonlyArray<{ label: string; min: number; max: number | null }> = [
  { label: "$0–$1", min: 0, max: 1 },
  { label: "$1–$10", min: 1, max: 10 },
  { label: "$10–$50", min: 10, max: 50 },
  { label: "$50–$100", min: 50, max: 100 },
  { label: "$100–$500", min: 100, max: 500 },
  { label: "$500+", min: 500, max: null },
];

// HELD-ONLY FILTER (CRITICAL) — the wipe must target ONLY the cards the user
// CURRENTLY holds, i.e. the exact set the /users/[id] Balances card shows as
// the "Inventory" value/count, NOT the user's lifetime inventory history.
//
// `user_inventory` rows are never hard-deleted by the platform on disposal —
// a card leaves the user's holdings when one of three timestamps is set:
//   • sold_at              — the card was sold back for balance,
//   • exchanged_at         — the card was exchanged out,
//   • withdrawal_locked_at — the card is locked for an in-flight physical/
//                            crypto withdrawal (its id is bundled into a
//                            pending `card_withdrawals.inventory_item_ids`).
// A row with ANY of these set is no longer "held" and is left as historical
// record. A row with ALL THREE null is currently held.
//
// This is the SAME predicate the displayed inventory uses:
//   • the Balances "Inventory" VALUE → calculateUserPnl inventoryValue
//     (src/lib/queries/pnl.ts: sold_at null + exchanged_at null +
//     withdrawal_locked_at null) — the $-figure the owner compares against,
//   • and the dashboard/users-list/users-mini inventory aggregates, which all
//     filter the same way.
// Matching it makes the wipe preview equal the displayed held inventory and
// guarantees the wipe never deletes a card that is mid-withdrawal (which would
// orphan an active card_withdrawals row). Disposed/withdrawn rows are NOT
// counted, snapshotted, or deleted — they stay as the historical record.
const HELD_INVENTORY_FILTER = {
  sold_at: null,
  exchanged_at: null,
  withdrawal_locked_at: null,
} satisfies Pick<
  Prisma.user_inventoryWhereInput,
  "sold_at" | "exchanged_at" | "withdrawal_locked_at"
>;

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
 * Count + summed value_at_obtained of the CURRENTLY-HELD user_inventory rows
 * the wipe would delete (HELD_INVENTORY_FILTER — the exact set shown as the
 * Balances "Inventory" value/count; sold/exchanged/withdrawal-locked history
 * is excluded), plus three views the admin reviews before the 2FA approve:
 *   1. a per-`source_type` breakdown (count + value) — confirms the inventory
 *      holds only won/granted cards (source_type ∈ pack/battle/reward/
 *      exchange/raffle/upgrader); there is no creator-deal source, so nothing
 *      protected is in inventory;
 *   2. the top ≤10 items by value (resolved to card names) — so the admin
 *      sees WHAT the headline value actually is (e.g. one big card vs a long
 *      cheap tail), not just a count;
 *   3. a fixed-band value-tier distribution over ALL rows — the shape of the
 *      wipe (how many high-value vs cheap items).
 *
 * All scoped strictly to this user. Read-only; reuses the same row set the
 * wipe snapshots/deletes. The card-name resolution mirrors getUserInventory
 * (separate cards lookup keyed by card_id — user_inventory has no `cards`
 * relation, so this is two same-DB reads, not a cross-DB join).
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
  // Scope to THIS user AND only their currently-held cards (HELD_INVENTORY_FILTER
  // — sold/exchanged/withdrawal-locked rows are excluded so the preview equals
  // the displayed Balances "Inventory" value/count, not the lifetime history).
  const userWhere = {
    user_id: parsed.data,
    ...HELD_INVENTORY_FILTER,
  } satisfies Prisma.user_inventoryWhereInput;

  // Run the three reads together — each is scoped by the indexed `user_id`, so
  // this is the single user's (small) inventory only, no global scan. Kept as
  // separate awaited values (not one mixed Promise.all tuple) so each keeps
  // its own precise type.
  const [grouped, topRows, tierAggregates] = await Promise.all([
    // (1) per-source breakdown.
    db.user_inventory.groupBy({
      by: ["source_type"],
      where: userWhere,
      _count: { _all: true },
      _sum: { value_at_obtained: true },
    }),
    // (2) top items by value — single bounded orderBy, only the columns we
    // need (value + card_id for the name lookup).
    db.user_inventory.findMany({
      where: userWhere,
      orderBy: { value_at_obtained: "desc" },
      take: 10,
      select: { id: true, card_id: true, value_at_obtained: true },
    }),
    // (3) one aggregate per fixed value band (count + summed value). A fixed
    // handful of aggregates over one user's rows is cheap.
    Promise.all(
      INVENTORY_VALUE_TIER_BANDS.map((band) =>
        db.user_inventory.aggregate({
          where: {
            ...userWhere,
            value_at_obtained:
              band.max == null ? { gte: band.min } : { gte: band.min, lt: band.max },
          },
          _count: { _all: true },
          _sum: { value_at_obtained: true },
        }),
      ),
    ),
  ]);

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
  // Largest groups first so the preview reads cleanly.
  bySource.sort((a, b) => b.count - a.count);

  // Resolve card names for the top items (same pattern as getUserInventory —
  // user_inventory has no `cards` relation, so we look the names up by id).
  const cardIds = [...new Set(topRows.map((r) => r.card_id))];
  const cards =
    cardIds.length > 0
      ? await db.cards.findMany({ where: { id: { in: cardIds } }, select: { id: true, name: true } })
      : [];
  const cardNameById = new Map(cards.map((c) => [c.id, c.name]));
  const topItems: InventoryTopItem[] = topRows.map((r) => ({
    id: r.id,
    name: cardNameById.get(r.card_id) ?? "Unknown card",
    value: toNumber(r.value_at_obtained),
  }));

  // Keep only non-empty tiers, preserving the ascending band order.
  const valueTiers: InventoryValueTier[] = INVENTORY_VALUE_TIER_BANDS.map((band, i) => {
    const agg = tierAggregates[i];
    return {
      label: band.label,
      min: band.min,
      max: band.max,
      count: agg?._count._all ?? 0,
      value: toNumber(agg?._sum.value_at_obtained),
    };
  }).filter((t) => t.count > 0);

  return {
    success: true,
    preview: { itemCount, totalValue, bySource, topItems, valueTiers },
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
        // 'pending' until the destructive main-DB tx commits AND the
        // status→completed + audit row are written atomically below.
        status: WIPE_STATUS.PENDING,
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
    // Main-DB tx failed → nothing changed. Mark the snapshot 'failed' (a
    // terminal, detectable state restore refuses) instead of deleting it, so
    // it can't surface as a phantom restorable (restoring it would credit
    // money that was never removed) AND there's a reconcilable record that
    // this delete did not happen.
    await markWipeFailed("account", wipeId);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("concurrently")) return { success: false, error: message };
    console.error("[wipeBalance] zero-balance transaction failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing changed)" };
  }

  // The destructive delete has COMMITTED. Atomically (one admin-DB tx) flip
  // the snapshot status → 'completed' AND write the audit event, so a
  // committed wipe can never be left without an audit row. If finalize fails
  // after all retries the snapshot is left 'pending' (detectable) + logged
  // CRITICAL; we surface that to the admin while keeping the wipe recoverable.
  const finalized = await finalizeWipeSuccess({
    store: "account",
    wipeId,
    audit: {
      adminUserId: session.userId,
      eventType: "user_balance_wiped",
      targetUserId: parsed.userId,
      ip: await resolveRequestIp(),
      metadata: {
        wipeId,
        amountRemoved: balanceBefore,
        balanceBefore,
        balanceAfter: 0,
        recoverable: true,
        note: "snapshot+reset (no ledger row); remaining ledger balance_before/after not rewritten",
      },
    },
  });
  if (!finalized.ok) {
    invalidateMetricCaches(parsed.userId);
    return {
      success: false,
      error:
        "Balance was wiped (recoverable), but the audit record could not be finalized — the wipe is logged as 'pending' for reconciliation. Please notify an administrator.",
    };
  }

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
        // 'pending' until the destructive main-DB tx commits AND the
        // status→completed + audit row are written atomically below.
        status: WIPE_STATUS.PENDING,
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
    // Main-DB tx failed → nothing changed. Mark 'failed' (terminal, restore
    // refuses it) rather than deleting the snapshot, for a reconcilable record.
    await markWipeFailed("account", wipeId);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("concurrently")) return { success: false, error: message };
    console.error("[wipeVault] zero-vault transaction failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing changed)" };
  }

  // Destructive delete COMMITTED → atomically flip status→completed + write
  // the audit event (one admin-DB tx). See wipeBalance for the full rationale.
  const finalized = await finalizeWipeSuccess({
    store: "account",
    wipeId,
    audit: {
      adminUserId: session.userId,
      eventType: "user_vault_wiped",
      targetUserId: parsed.userId,
      ip: await resolveRequestIp(),
      metadata: {
        wipeId,
        amountRemoved: lockedBefore,
        lockedBefore,
        unlockAtBefore,
        recoverable: true,
        note: "snapshot+reset (no ledger row); locked_balance zeroed + unlock_at cleared",
      },
    },
  });
  if (!finalized.ok) {
    invalidateMetricCaches(parsed.userId);
    return {
      success: false,
      error:
        "Vault was wiped (recoverable), but the audit record could not be finalized — the wipe is logged as 'pending' for reconciliation. Please notify an administrator.",
    };
  }

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
 * Hard-delete every CURRENTLY-HELD `user_inventory` row owned by this user —
 * the same held set the /users/[id] Balances card shows as the "Inventory"
 * value/count (HELD_INVENTORY_FILTER: sold_at null + exchanged_at null +
 * withdrawal_locked_at null). Sold / exchanged / withdrawal-locked rows are
 * the user's lifetime history and are NOT touched (left as record). Snapshot-
 * first (the held rows are written to admin_account_wipes), then a main-DB tx
 * deletes exactly this user's held rows (and the `provably_fair_results` that
 * FK to those rows, which would otherwise block the delete). Restore re-inserts
 * the snapshotted held rows verbatim.
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
  // this user AND only their currently-held cards (HELD_INVENTORY_FILTER) — we
  // snapshot/delete exactly the held set shown on the Balances card, never the
  // sold/exchanged/withdrawal-locked historical rows. Bounded by
  // MAX_INVENTORY_ROWS+1 so we can detect an over-cap inventory without
  // scanning unboundedly.
  const rows = await db.user_inventory.findMany({
    where: { user_id: parsed.userId, ...HELD_INVENTORY_FILTER },
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
        // 'pending' until the destructive main-DB tx commits AND the
        // status→completed + audit row are written atomically below.
        status: WIPE_STATUS.PENDING,
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

  // DESTRUCTIVE — delete the HELD rows we snapshotted (+ their
  // provably_fair_results children which FK to user_inventory.id) scoped to
  // THIS user. The delete is re-scoped by user_id AND the held-filter so it
  // can't touch another user's rows — nor this user's disposed/withdrawal-
  // locked historical rows — even under a race, and the count is verified.
  try {
    await db.$transaction(async (tx) => {
      // provably_fair_results.inventory_item_id → user_inventory.id. Delete
      // ONLY the PF children of the exact held inventory ids being wiped (NOT
      // every PF row for the user) so the FK on those rows is cleared without
      // touching PF data that belongs to surviving disposed/withdrawn rows.
      await tx.provably_fair_results.deleteMany({
        where: { inventory_item_id: { in: inventoryIds } },
      });
      const del = await tx.user_inventory.deleteMany({
        where: { id: { in: inventoryIds }, user_id: parsed.userId, ...HELD_INVENTORY_FILTER },
      });
      if (del.count !== inventoryIds.length) {
        // A row was added/removed/disposed concurrently between the snapshot
        // read and the delete → abort so the snapshot and the actual delete
        // agree.
        throw new Error("INV_GUARD: inventory changed concurrently — refresh and retry");
      }
    });
  } catch (err) {
    // Main-DB tx failed → nothing deleted. Mark 'failed' (terminal, restore
    // refuses it) rather than deleting the snapshot, for a reconcilable record.
    await markWipeFailed("account", wipeId);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.startsWith("INV_GUARD:")) {
      return { success: false, error: message.replace(/^INV_GUARD:\s*/, "") };
    }
    console.error("[wipeInventory] delete transaction failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing deleted)" };
  }

  // Destructive delete COMMITTED → atomically flip status→completed + write
  // the audit event (one admin-DB tx). See wipeBalance for the full rationale.
  const finalized = await finalizeWipeSuccess({
    store: "account",
    wipeId,
    audit: {
      adminUserId: session.userId,
      eventType: "user_inventory_wiped",
      targetUserId: parsed.userId,
      ip: await resolveRequestIp(),
      metadata: {
        wipeId,
        deletedCount: rows.length,
        totalValue,
        countBySource,
        recoverable: true,
        heldOnly: true,
        note: "CURRENTLY-HELD user_inventory rows deleted (sold_at null + exchanged_at null + withdrawal_locked_at null — matches the Balances 'Inventory' value/count; sold/exchanged/withdrawal-locked history left untouched). Their provably_fair_results cascade-delete and are NOT re-created on restore — historical PF leaf data, same tradeoff as deleted-user restore; value_at_obtained feeds GGR inv-leg (restorable). Inventory has no creator-deal source — deal payouts are vouchers, not inventory, and are untouched.",
      },
    },
  });
  if (!finalized.ok) {
    invalidateMetricCaches(parsed.userId);
    return {
      success: false,
      error:
        "Inventory was wiped (recoverable), but the audit record could not be finalized — the wipe is logged as 'pending' for reconciliation. Please notify an administrator.",
    };
  }

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
  /**
   * Lifecycle status of the wipe snapshot. 'completed' is the normal, fully-
   * finalized + restorable state (and the back-compat value for rows that
   * predate the column). 'pending' means the committed wipe's audit-finalize
   * did not complete (restore is refused until reconciled). 'failed' rows
   * (the delete never happened) are filtered OUT of this listing entirely.
   */
  status: WipeStatus;
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
    // Exclude 'failed' rows: those are deletes that DID NOT happen (the
    // main-DB tx rolled back), so they are not real wipe history and must
    // never appear as a restorable entry. 'completed' (incl. back-compat
    // legacy rows) + 'pending' (committed but audit-unfinalized) are shown.
    where: { user_id: parsed.data, status: { not: WIPE_STATUS.FAILED } },
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
    status: (w.status as WipeStatus),
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
 *   - deposits  → re-insert the snapshotted `deposit` ledger rows + re-add the
 *                 recorded total_deposited reduction to the counter.
 *   - wager     → re-insert the wager+payout ledger legs, the won pack/battle
 *                 inventory rows, their provably_fair_results (AFTER the
 *                 inventory — PF FK-references it), and the upgrader_games rows
 *                 (raw SQL); re-add EXACTLY the recorded balance reduction
 *                 (the payout clawback) to available_balance AND the recorded
 *                 lifetime-counter reductions to balances.total_wagered /
 *                 total_won (so the user re-appears in the cost-breakdown
 *                 contributors). Wager (debit) legs are NOT re-subtracted from
 *                 the balance (they were deleted without giving the stake back;
 *                 re-inserting the row + not touching the balance is the
 *                 symmetric reverse).
 *
 * Idempotent-guarded: a record already marked restored_at cannot be restored
 * again (double-credit / double-insert). Balance/vault/deposit/wager counter
 * re-credits are optimistic-locked against the LIVE row (not the stale
 * wipe-time version) so the restore is additive to whatever the value is now.
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
  // STATUS GUARD — only a 'completed' wipe is safely restorable. A 'failed'
  // row's delete never happened (restoring it would credit money/items that
  // were never removed); a 'pending' row's audit-finalize is incomplete (the
  // wipe itself committed, but it needs reconciliation before it's restored).
  // 'completed' is also the back-compat value for legacy rows predating the
  // column, so existing wipes restore exactly as before.
  if (wipe.status !== WIPE_STATUS.COMPLETED) {
    return {
      success: false,
      error:
        wipe.status === WIPE_STATUS.FAILED
          ? "This wipe did not complete (the deletion never happened) and cannot be restored."
          : "This wipe is still being finalized (pending) and cannot be restored yet — please reconcile it first.",
    };
  }

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
    } else if (snapshot.type === "deposits") {
      // Re-insert the deleted `deposit` ledger rows verbatim AND re-add the
      // EXACT clamped total_deposited reduction recorded in the snapshot (never
      // more than was removed). The re-inserted rows' historical
      // balance_before/after are NOT rewritten (same fidelity tradeoff the
      // adjustments wipe documents). balances.last_transaction_id is NOT
      // restored — it self-heals on the next real transaction.
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
      const addBackCounter = toNumber(snapshot.totalDepositedReduction);
      await db.$transaction(async (tx) => {
        // skipDuplicates makes a retried restore safe.
        await tx.ledger_transactions.createMany({
          data: rowsForInsert as unknown as Prisma.ledger_transactionsCreateManyInput[],
          skipDuplicates: true,
        });
        if (addBackCounter > 0) {
          const b = await tx.balances.findUnique({ where: { user_id: snapshot.userId } });
          if (!b) throw new Error("User balances not found");
          const updated = await tx.balances.updateMany({
            where: { user_id: snapshot.userId, version: b.version },
            data: {
              total_deposited: toNumber(b.total_deposited) + addBackCounter,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) throw new Error("Balance changed concurrently — please retry");
        }
      });
    } else if (snapshot.type === "wager") {
      // Re-insert the wager+payout ledger legs, the won pack/battle inventory,
      // their provably_fair_results (AFTER the inventory — PF FK-references
      // user_inventory), and the upgrader_games rows (raw SQL). Re-add EXACTLY
      // the recorded balance reduction (the payout clawback). Best-effort
      // reconstruction (the snapshot is the source of truth); the re-inserted
      // rows' historical balance_before/after are NOT rewritten. The session
      // bet pointer + balances.last_transaction_id we nulled on wipe are NOT
      // restored — they self-heal.
      const stripUndef = (r: Record<string, unknown>): Record<string, unknown> => {
        const copy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (v === undefined) continue;
          copy[k] = v;
        }
        return copy;
      };
      if (
        !Array.isArray(snapshot.ledgerRows) ||
        !Array.isArray(snapshot.inventoryRows) ||
        !Array.isArray(snapshot.provablyFairRows) ||
        !Array.isArray(snapshot.upgraderGameRows)
      ) {
        return { success: false, error: "Snapshot is malformed — cannot restore" };
      }
      const ledgerForInsert = snapshot.ledgerRows.map(stripUndef);
      const inventoryForInsert = snapshot.inventoryRows.map(stripUndef);
      const pfForInsert = snapshot.provablyFairRows.map(stripUndef);
      const upgraderForInsert = snapshot.upgraderGameRows.map(stripUndef);
      const addBackBalance = toNumber(snapshot.balanceReduction);
      // The EXACT clamped lifetime-counter reductions the wipe subtracted
      // (Σ wager-leg magnitudes / Σ payout-leg + won-inventory value). Re-added
      // additively to the LIVE counters so a restore fully reverses the drop.
      // Back-compat: pre-this-change snapshots lack these keys → toNumber()
      // yields 0, so an older wager wipe restores exactly as before (no counter
      // re-add — it didn't decrement them either).
      const addBackTotalWagered = toNumber(snapshot.totalWageredReduction);
      const addBackTotalWon = toNumber(snapshot.totalWonReduction);

      await db.$transaction(async (tx) => {
        // (1) Ledger legs back first (skipDuplicates → retry-safe). Their
        // game_session_id points at sessions that were never deleted, so the FK
        // resolves.
        if (ledgerForInsert.length > 0) {
          await tx.ledger_transactions.createMany({
            data: ledgerForInsert as unknown as Prisma.ledger_transactionsCreateManyInput[],
            skipDuplicates: true,
          });
        }
        // (2) Inventory back BEFORE the provably_fair_results (PF FK-references
        // user_inventory.id).
        if (inventoryForInsert.length > 0) {
          await tx.user_inventory.createMany({
            data: inventoryForInsert as unknown as Prisma.user_inventoryCreateManyInput[],
            skipDuplicates: true,
          });
        }
        // (3) provably_fair_results back (after the inventory they reference).
        if (pfForInsert.length > 0) {
          await tx.provably_fair_results.createMany({
            data: pfForInsert as unknown as Prisma.provably_fair_resultsCreateManyInput[],
            skipDuplicates: true,
          });
        }
        // (4) upgrader_games back via raw SQL (table not in the Prisma client).
        // Build a column list from each row's keys; values bound as params.
        // Guarded by a regclass probe — if the DB lacks the table the rows
        // can't be restored (best-effort: surfaced, not fatal).
        if (upgraderForInsert.length > 0) {
          const probe = await tx.$queryRawUnsafe<Array<{ exists: string | null }>>(
            `SELECT to_regclass('public.upgrader_games')::text AS exists`,
          );
          if (probe?.[0]?.exists) {
            for (const row of upgraderForInsert) {
              const keys = Object.keys(row);
              if (keys.length === 0) continue;
              const cols = keys.map((k) => `"${k.replace(/"/g, '""')}"`).join(", ");
              const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
              const values = keys.map((k) => row[k]);
              // ON CONFLICT DO NOTHING keeps a retried restore safe (id PK).
              await tx.$executeRawUnsafe(
                `INSERT INTO upgrader_games (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
                ...values,
              );
            }
          }
        }
        // (5) Re-add EXACTLY the recorded reductions, additively to the LIVE
        // values, under one optimistic version lock:
        //   • available_balance += the payout clawback (payout legs only).
        //   • total_wagered     += the wager-leg reduction.
        //   • total_won         += the payout-leg + won-inventory reduction.
        // Fired when ANY is > 0 (a pure-wager wipe re-adds total_wagered with no
        // balance change). All re-adds are additive to whatever the value is now,
        // so the restore is correct even if the user kept playing after the wipe.
        if (addBackBalance > 0 || addBackTotalWagered > 0 || addBackTotalWon > 0) {
          const b = await tx.balances.findUnique({ where: { user_id: snapshot.userId } });
          if (!b) throw new Error("User balances not found");
          const updated = await tx.balances.updateMany({
            where: { user_id: snapshot.userId, version: b.version },
            data: {
              available_balance: toNumber(b.available_balance) + addBackBalance,
              total_wagered: toNumber(b.total_wagered) + addBackTotalWagered,
              total_won: toNumber(b.total_won) + addBackTotalWon,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) throw new Error("Balance changed concurrently — please retry");
        }
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
