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
  type AccountWipeSnapshot,
  type DepositsWipeSnapshot,
} from "@/lib/account-wipes/snapshot";
import { getCreatorProtectionStatus } from "@/lib/account-wipes/creator-protection";
import { wipeCategoryBlockReason } from "@/lib/account-wipes/categories";

// ---------------------------------------------------------------------------
// WIPE DEPOSITS — the FIFTH recoverable, targeted wipe, alongside the
// adjustments / balance / vault / inventory set. Deletes the user's `deposit`
// LEDGER rows (snapshot-first), reduces the lifetime `balances.total_deposited`
// counter by the wiped sum, and is fully restorable.
//
// WHY DEPOSITS ARE SAFE TO WIPE RECOVERABLY (verified against the schema):
//
//  • A `deposit` ledger_transactions row is the cash-IN event. It is a pure
//    row in `ledger_transactions` with the SAME structure as the
//    admin_balance_adjustment rows the (proven) adjustments wipe already
//    deletes + restores. The ONLY inbound FK reference to a deposit row is
//    `balances.last_transaction_id` (a nullable denorm pointer to the latest
//    tx). The reward/gaming child tables (gift_cards / promo_code_redemptions
//    / race_claims / rakeback_claims / game_sessions.bet_ledger_tx_id) point
//    at THEIR OWN ledger types, NEVER at a `deposit` row — so deleting a
//    deposit row orphans nothing there. We null `last_transaction_id` if it
//    points to a wiped deposit (it self-heals on the next real tx). Forward
//    refs (`deposit_address_id` → deposit_addresses) are untouched — we never
//    delete a deposit_addresses row.
//
//  • LIFETIME COUNTER: unlike the narrow balance/vault/inventory wipes (which
//    deliberately leave `balances.total_*` alone), the owner mandate for the
//    DEPOSITS category is to "reduce the lifetime deposited counter". So this
//    action subtracts the wiped sum from `balances.total_deposited` (clamped
//    at 0; the clamp delta is recorded). Restore re-adds EXACTLY the clamped
//    amount that was subtracted (stored in the snapshot), so it is symmetric.
//
//  • We deliberately do NOT touch `available_balance`. A deposit's money long
//    ago flowed into wagers / withdrawals / the current balance; the current
//    balance reflects winnings & losses, not the original deposit. Reducing
//    live balance by the historical deposit sum would wrongly zero legitimate
//    current funds. The deposit category claws back the deposit RECORD + the
//    lifetime counter; the live spendable pool is governed by the separate
//    Balance wipe.
//
// CREATOR-PROTECTED (owner mandate, 2026-06-03): deposits are in the
// creator-protected set. When the target user IS or WAS a creator this action
// HARD-REJECTS server-side (the server re-derives the ever-creator flag — it
// never trusts the client). The panel disables the category for creators too.
//
// ORDERING (CRITICAL, snapshot-first): the recovery snapshot is written to the
// admin DB and confirmed BEFORE the destructive main-DB write. If the snapshot
// can't be written → abort (nothing changes). If the main-DB tx fails AFTER
// the snapshot was written, the orphan snapshot is deleted.
//
// DUAL-DB (strict): destructive reads/writes on the main `db`
// (ledger_transactions / balances); snapshot on `adminDb`
// (admin_account_wipes). No cross-DB joins.
//
// GATING: requireAdmin + __can_wipe_accounts + 2FA, preview+confirm upstream,
// hard ownership + type + status re-check on every row.
// ---------------------------------------------------------------------------

/** The ledger enum value real deposits are written with. */
const DEPOSIT_TYPE = "deposit" as const;

/**
 * Sanity ceiling on rows we snapshot in one wipe. Mirrors the inventory cap —
 * a pathological deposit history must not produce a multi-hundred-MB JSONB
 * blob. Over the cap we refuse rather than truncate (a truncated snapshot is
 * not recoverable).
 */
const MAX_DEPOSIT_ROWS = 50_000;

async function gateWipe() {
  const session = await requireAdmin();
  await requireCapability(session, "__can_wipe_accounts", "wipe deposits");
  return session;
}

const userIdSchema = z.string().min(1, "User id is required");

// ───────────────────────────────────────────────────────────────────────────
// Preview — lazy, called when the Deposits category is ticked. Read-only.
// ───────────────────────────────────────────────────────────────────────────

export type DepositsWipePreview = {
  count: number;
  totalAmount: number;
  /** Current lifetime balances.total_deposited (the counter that will be reduced). */
  totalDeposited: number;
  /**
   * True when the target user IS or WAS a creator → the category is protected
   * and this action will hard-reject. Surfaced so the dialog can render the
   * "Protected — creator" note even if it failed to thread the role prop.
   */
  creatorProtected: boolean;
  /** The newest few deposits (date + amount) for the admin to eyeball. */
  recent: Array<{ id: string; amount: number; createdAt: string; description: string }>;
};

/**
 * Count + summed amount of the user's completed `deposit` ledger rows the
 * wipe would delete, the current lifetime total_deposited, the creator-
 * protected flag, and a small recent sample. Read-only, scoped to this user.
 */
export async function previewDepositsWipe(
  userId: string,
): Promise<{ success: true; preview: DepositsWipePreview } | { success: false; error: string }> {
  await gateWipe();
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid user id" };
  }
  const db = await getDb();

  const where = {
    user_id: parsed.data,
    type: DEPOSIT_TYPE,
    status: "completed",
  } satisfies Prisma.ledger_transactionsWhereInput;

  const [agg, balanceRow, recentRows, creatorStatus] = await Promise.all([
    db.ledger_transactions.aggregate({
      where,
      _count: { _all: true },
      _sum: { amount: true },
    }),
    db.balances.findUnique({
      where: { user_id: parsed.data },
      select: { total_deposited: true },
    }),
    db.ledger_transactions.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: 8,
      select: { id: true, amount: true, created_at: true, description: true },
    }),
    getCreatorProtectionStatus(parsed.data),
  ]);

  return {
    success: true,
    preview: {
      count: agg._count._all,
      totalAmount: toNumber(agg._sum.amount),
      totalDeposited: toNumber(balanceRow?.total_deposited),
      creatorProtected: creatorStatus.everCreator,
      recent: recentRows.map((r) => ({
        id: r.id,
        amount: toNumber(r.amount),
        createdAt: r.created_at.toISOString(),
        description: r.description,
      })),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// WIPE — snapshot deposit rows + the counter reduction, delete rows + reduce
// the counter, audit, recoverable.
// ───────────────────────────────────────────────────────────────────────────

const wipeDepositsSchema = z.object({
  userId: z.string().min(1, "User id is required"),
  totpCode: z.string().min(1, "2FA code is required"),
});

export async function wipeDeposits(data: {
  userId: string;
  totpCode: string;
}): Promise<
  | { success: true; deletedCount: number; totalAmount: number; counterReduced: number }
  | { success: false; error: string }
> {
  const session = await gateWipe();

  const parseResult = wipeDepositsSchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  try {
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  // CREATOR-CONDITIONAL HARD GUARD (server-re-derived, dual-DB): deposits are
  // creator-protected. If the user IS or WAS a creator, reject — even under a
  // tampered request. Never trusts the client; recomputes from the DBs.
  // Fail-closed (a derivation error → everCreator: true → reject).
  const { everCreator } = await getCreatorProtectionStatus(parsed.userId);
  const blockReason = wipeCategoryBlockReason("deposits", everCreator);
  if (blockReason) {
    return { success: false, error: blockReason };
  }

  try {
    await ensureAccountWipesSchema();
  } catch (err) {
    console.error("[wipeDeposits] ensure-schema failed:", err);
    return {
      success: false,
      error: "Could not prepare the recovery store — wipe aborted (nothing deleted)",
    };
  }

  const db = await getDb();

  // Read the FULL deposit rows up front so the snapshot is exact. Scoped
  // strictly to this user + type=deposit + completed. Bounded by
  // MAX_DEPOSIT_ROWS+1 so an over-cap history is detected without an unbounded
  // scan.
  const rows = await db.ledger_transactions.findMany({
    where: { user_id: parsed.userId, type: DEPOSIT_TYPE, status: "completed" },
    take: MAX_DEPOSIT_ROWS + 1,
  });

  if (rows.length === 0) {
    return { success: false, error: "This user has no deposits to wipe" };
  }
  if (rows.length > MAX_DEPOSIT_ROWS) {
    return {
      success: false,
      error: `Deposit history too large to snapshot safely (> ${MAX_DEPOSIT_ROWS.toLocaleString()} rows) — wipe aborted`,
    };
  }

  // HARD RE-GUARD on every row (defence in depth): every row must be this
  // user's completed `deposit`. A foreign/mistyped row aborts the whole wipe.
  for (const row of rows) {
    if (row.user_id !== parsed.userId || row.type !== DEPOSIT_TYPE || row.status !== "completed") {
      return {
        success: false,
        error: "A selected deposit row failed the ownership/type check — wipe aborted (nothing deleted)",
      };
    }
  }

  const depositIds = rows.map((r) => r.id);
  const totalAmount = rows.reduce((acc, r) => acc + toNumber(r.amount), 0);

  // Read the lifetime counter + optimistic-lock version so the reduction is
  // race-safe and the snapshot records the EXACT clamped reduction.
  const balanceRow = await db.balances
    .findUnique({ where: { user_id: parsed.userId } })
    .catch(() => null);
  if (!balanceRow) return { success: false, error: "User balances not found" };
  const totalDepositedBefore = toNumber(balanceRow.total_deposited);
  const lockVersion = balanceRow.version;
  // Never drive the counter negative. The clamped reduction is what we
  // actually subtract AND what Restore re-adds (stored in the snapshot), so
  // wipe/restore are symmetric even if total_deposited < Σ deposits.
  const counterReduction = Math.min(totalAmount, totalDepositedBefore);
  const counterClamped = totalAmount > totalDepositedBefore;

  const userMeta = await db.user
    .findUnique({ where: { id: parsed.userId }, select: { username: true, email: true } })
    .catch(() => null);

  // SNAPSHOT FIRST — write the full rows + the exact counter reduction. Abort
  // on failure (nothing deleted).
  const snapshot: AccountWipeSnapshot = {
    type: "deposits",
    userId: parsed.userId,
    rows: rows as unknown as Array<Record<string, unknown>>,
    totalAmount: totalAmount.toFixed(2),
    totalDepositedReduction: counterReduction.toFixed(2),
  } satisfies { type: "deposits" } & DepositsWipeSnapshot;

  let wipeId: string;
  try {
    const created = await adminDb.admin_account_wipes.create({
      data: {
        wipe_type: "deposits",
        user_id: parsed.userId,
        username: userMeta?.username ?? null,
        email: userMeta?.email ?? null,
        wiped_by: session.userId,
        amount: totalAmount,
        item_count: rows.length,
        snapshot: accountWipeSnapshotToJsonValue(snapshot) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    wipeId = created.id;
  } catch (snapErr) {
    console.error("[wipeDeposits] snapshot write failed — wipe aborted (nothing deleted):", snapErr);
    return {
      success: false,
      error: "Could not write the recovery snapshot — wipe aborted (nothing deleted)",
    };
  }

  // DESTRUCTIVE — in ONE main-DB tx: null any balances.last_transaction_id
  // that points at a wiped deposit (so the FK doesn't block the delete),
  // delete the deposit rows (re-scoped by user + type + status so a race can't
  // widen the blast radius, count verified), and reduce total_deposited by the
  // clamped amount under the version lock.
  try {
    await db.$transaction(async (tx) => {
      // Clear the denorm pointer if it references one of the rows we're about
      // to delete (FK is RESTRICT — would otherwise block). It self-heals on
      // the next real transaction; we never restore it.
      await tx.balances.updateMany({
        where: { user_id: parsed.userId, last_transaction_id: { in: depositIds } },
        data: { last_transaction_id: null },
      });

      const del = await tx.ledger_transactions.deleteMany({
        where: {
          id: { in: depositIds },
          user_id: parsed.userId,
          type: DEPOSIT_TYPE,
          status: "completed",
        },
      });
      if (del.count !== depositIds.length) {
        throw new Error("DEP_GUARD: deposits changed concurrently — refresh and retry");
      }

      // Reduce the lifetime counter by the clamped amount, optimistic-locked.
      const updated = await tx.balances.updateMany({
        where: { user_id: parsed.userId, version: lockVersion },
        data: {
          total_deposited: totalDepositedBefore - counterReduction,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }
    });
  } catch (err) {
    await adminDb.admin_account_wipes.delete({ where: { id: wipeId } }).catch((cleanupErr) => {
      console.error(
        "[wipeDeposits] CRITICAL: main-DB wipe failed AND orphan snapshot cleanup failed — snapshot",
        wipeId,
        "is orphaned (deposits not deleted; do NOT restore it):",
        cleanupErr,
      );
    });
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.startsWith("DEP_GUARD:")) {
      return { success: false, error: message.replace(/^DEP_GUARD:\s*/, "") };
    }
    if (message.includes("concurrently")) return { success: false, error: message };
    console.error("[wipeDeposits] delete transaction failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing deleted)" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_deposits_wiped",
    targetUserId: parsed.userId,
    metadata: {
      wipeId,
      deletedCount: rows.length,
      totalAmount,
      totalDepositedBefore,
      counterReduced: counterReduction,
      counterClamped,
      recoverable: true,
      note: "deposit ledger rows deleted + balances.total_deposited reduced by the clamped sum (restore re-inserts rows + re-adds the counter). available_balance intentionally NOT touched. balances.last_transaction_id nulled if it pointed at a wiped row (self-heals, not restored). Remaining ledger rows' balance_before/after not rewritten (same fidelity tradeoff as the adjustments wipe).",
    },
  });

  // Bust the user page + global metric caches — deposits feed the P&L
  // `deposits` term and dashboard SUM(total_deposited); restore reverses it.
  revalidatePath(`/users/${parsed.userId}`);
  invalidateMetricCaches(parsed.userId);
  return {
    success: true,
    deletedCount: rows.length,
    totalAmount,
    counterReduced: counterReduction,
  };
}
