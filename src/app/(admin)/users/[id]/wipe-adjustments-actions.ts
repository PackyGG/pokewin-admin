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
import { ensureBalanceAdjustmentWipesSchema } from "@/lib/balance-adjustment-wipes/ensure-schema";
import {
  wipeSnapshotToJsonValue,
  type BalanceAdjustmentWipeSnapshot,
} from "@/lib/balance-adjustment-wipes/snapshot";

// ---------------------------------------------------------------------------
// "Wipe content balance adjustments" — remove ONLY admin balance-adjustment
// ledger rows the admin explicitly selected, reduce the user's balance by
// the summed amount, and snapshot the deleted rows so the batch is
// recoverable.
//
// WHY: the owner gives creators admin balance adjustments so they can make
// content (open packs / stream). This cleans those out of a user's account
// WITHOUT touching real financial or gaming history.
//
// The ledger type that backs admin adjustments AND manual withdrawals is
// the SAME enum value: `admin_balance_adjustment` (verified against
// src/app/(admin)/users/[id]/actions.ts and
// src/lib/queries/insights-balance-adjustments/_shared.ts). The two are
// distinguished ONLY by the `description` prefix the write flows stamp:
//   - "Admin adjustment: <reason>"     ← a real balance adjustment (WIPEABLE)
//   - "Manual withdrawal: <reason> …"  ← an off-platform payout (NEVER wiped)
//
// So the wipeable set is: type === ADJ_TYPE AND description starts with
// ADJ_DESC_PREFIX. Manual withdrawals, deposits, withdrawals, affiliate
// claims, all gaming, and every creator/affiliate row are excluded — both
// by the listing query AND by a hard server-side guard below that re-reads
// every row before deletion and refuses anything that isn't a genuine
// "Admin adjustment:" row owned by this user.
// ---------------------------------------------------------------------------

/** The ledger enum value admin balance adjustments are written with. */
const ADJ_TYPE = "admin_balance_adjustment" as const;
/** Description prefix that marks a row as a genuine balance ADJUSTMENT. */
const ADJ_DESC_PREFIX = "Admin adjustment: ";
/** Description prefix the manual-withdrawal flow uses — must NOT be wiped. */
const MANUAL_WD_DESC_PREFIX = "Manual withdrawal:";

/** Max rows we surface / accept in one wipe batch (sanity bound). */
const MAX_BATCH = 500;

export type WipeableAdjustment = {
  id: string;
  amount: number;
  /** Raw admin reason — description with the "Admin adjustment: " prefix stripped. */
  reason: string;
  createdAt: string;
};

export type RecoverableWipe = {
  id: string;
  wipedAt: string;
  wipedByLabel: string;
  totalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  adjustmentCount: number;
  restoredAt: string | null;
  restoredByLabel: string | null;
};

/**
 * Shared gate for every action in this file. Mirrors the destructive
 * `wipeUserAccount` gate (requireAdmin + __can_wipe_accounts) — this is a
 * hard-delete of money rows, so it gets the strongest gate on the page, not
 * the permissive __can_adjust_balance capability. Returns the session.
 */
async function gateWipe() {
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_wipe_accounts",
    "wipe balance adjustments",
  );
  return session;
}

const userIdSchema = z.string().min(1, "User id is required");

/**
 * Lazily list THIS user's wipeable admin balance-adjustment rows. Called by
 * the dialog when it opens (the dialog is a hidden component — per the
 * active-data rule we do NOT preload these on page render). Read-only.
 *
 * Filters to the genuine "Admin adjustment:" subset — manual withdrawals
 * (same ledger type, different prefix) are excluded so they can never be
 * selected for deletion.
 */
export async function listWipeableAdjustments(
  userId: string,
): Promise<{ success: true; rows: WipeableAdjustment[] } | { success: false; error: string }> {
  await gateWipe();

  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid user id" };
  }

  const db = await getDb();
  // Filter to genuine admin adjustments only. `startsWith` on the
  // description excludes "Manual withdrawal:" rows (same type) and any
  // other future prefix. status = completed mirrors how the rows are
  // written (and how the insights surface counts them).
  const rows = await db.ledger_transactions.findMany({
    where: {
      user_id: parsed.data,
      type: ADJ_TYPE,
      status: "completed",
      description: { startsWith: ADJ_DESC_PREFIX },
    },
    orderBy: { created_at: "desc" },
    take: MAX_BATCH,
    select: { id: true, amount: true, description: true, created_at: true },
  });

  return {
    success: true,
    rows: rows.map((r) => ({
      id: r.id,
      amount: toNumber(r.amount),
      reason: r.description.slice(ADJ_DESC_PREFIX.length),
      createdAt: r.created_at.toISOString(),
    })),
  };
}

/**
 * List recoverable wipe batches for a user (newest first), resolving the
 * admin display labels. Used by the user-detail "Recoverable wipes" strip
 * and its restore button. Read-only against the admin DB.
 */
export async function listBalanceAdjustmentWipes(
  userId: string,
): Promise<RecoverableWipe[]> {
  await gateWipe();

  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) return [];

  await ensureBalanceAdjustmentWipesSchema();

  const wipes = await adminDb.admin_balance_adjustment_wipes.findMany({
    where: { user_id: parsed.data },
    orderBy: { wiped_at: "desc" },
    take: 50,
  });
  if (wipes.length === 0) return [];

  // Resolve admin usernames for wiped_by / restored_by in one query.
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
  const labels = new Map(
    admins.map((a) => [a.id, a.display_username ?? a.username]),
  );

  return wipes.map((w) => ({
    id: w.id,
    wipedAt: w.wiped_at.toISOString(),
    wipedByLabel: labels.get(w.wiped_by) ?? w.wiped_by,
    totalAmount: toNumber(w.total_amount),
    balanceBefore: toNumber(w.balance_before),
    balanceAfter: toNumber(w.balance_after),
    adjustmentCount: w.adjustment_count,
    restoredAt: w.restored_at?.toISOString() ?? null,
    restoredByLabel: w.restored_by
      ? labels.get(w.restored_by) ?? w.restored_by
      : null,
  }));
}

const wipeSchema = z.object({
  userId: z.string().min(1, "User id is required"),
  ledgerIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one adjustment to wipe")
    .max(MAX_BATCH, `Cannot wipe more than ${MAX_BATCH} adjustments at once`),
  totpCode: z.string().min(1, "2FA code is required"),
});

/**
 * Hard-delete the selected admin balance-adjustment ledger rows, reduce the
 * user's available_balance by their summed amount, and snapshot the deleted
 * rows into the admin DB so the batch is recoverable.
 *
 * SAFETY (defence in depth, all server-side):
 *   1. Gate: requireAdmin + __can_wipe_accounts + 2FA.
 *   2. Inside a single main-DB $transaction, RE-READ every selected id and
 *      refuse the whole batch unless EVERY row is:
 *        - owned by `userId`,
 *        - type === admin_balance_adjustment,
 *        - description starts with "Admin adjustment: " (NOT a manual
 *          withdrawal, NOT any other prefix).
 *      A single bad/foreign/tampered id aborts the entire wipe — so a
 *      deposit / withdrawal / affiliate_claim / gaming / creator row can
 *      NEVER be deleted even if its id is injected.
 *   3. Delete EXACTLY those ids (deleteMany scoped by id + user + type +
 *      prefix — never a broad delete).
 *   4. Reduce available_balance by the SUM of the deleted amounts
 *      (optimistic-locked on `version`, mirroring adjustBalance in
 *      reverse). available_balance is never driven negative.
 *   5. Snapshot the deleted rows into admin_balance_adjustment_wipes
 *      (admin DB) — committed AFTER the main-DB tx so a snapshot-write
 *      failure can't leave the rows deleted-but-unrecoverable: if the
 *      snapshot insert throws, we re-insert the rows back into the main DB
 *      and re-add the balance (rollback) and report failure.
 *
 * CAVEAT (owner-accepted): hard-delete breaks balance_before/after
 * continuity on the user's REMAINING ledger rows. We correct the CURRENT
 * balance (step 4) but deliberately do NOT rewrite other rows' historical
 * balance_before/after. Surfaced in the dialog copy + the audit event.
 */
export async function wipeBalanceAdjustments(data: {
  userId: string;
  ledgerIds: string[];
  totpCode: string;
}): Promise<
  | { success: true; deletedCount: number; totalRemoved: number; balanceBefore: number; balanceAfter: number }
  | { success: false; error: string }
> {
  const session = await gateWipe();

  const parseResult = wipeSchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  // De-dupe ids defensively so a repeated id can't be counted twice toward
  // the balance reduction.
  const ids = Array.from(new Set(parsed.ledgerIds));

  try {
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  // Provision the snapshot table before we touch anything in the main DB —
  // if the admin DB / schema is unreachable we must NOT delete rows we
  // can't snapshot. A failure here aborts before any destructive write.
  try {
    await ensureBalanceAdjustmentWipesSchema();
  } catch (err) {
    console.error("[wipeBalanceAdjustments] ensure-schema failed:", err);
    return {
      success: false,
      error: "Could not prepare the recovery store — wipe aborted (nothing deleted)",
    };
  }

  const db = await getDb();

  // Full deleted-row snapshots captured inside the tx so the post-commit
  // admin-DB snapshot insert (and any rollback) has the exact rows.
  let deletedRows: Array<Record<string, unknown>> = [];
  let totalRemoved = 0;
  let balanceBefore = 0;
  let balanceAfter = 0;

  try {
    await db.$transaction(async (tx) => {
      // 1. Re-read the exact selected rows under the tx. This is the
      //    authoritative guard: we ONLY proceed on rows that are this
      //    user's genuine admin adjustments. Anything else → abort.
      const rows = await tx.ledger_transactions.findMany({
        where: { id: { in: ids } },
      });

      if (rows.length !== ids.length) {
        throw new Error("WIPE_GUARD: some selected adjustments no longer exist — refresh and retry");
      }

      for (const row of rows) {
        if (row.user_id !== parsed.userId) {
          throw new Error("WIPE_GUARD: a selected row does not belong to this user");
        }
        if (row.type !== ADJ_TYPE) {
          throw new Error("WIPE_GUARD: a selected row is not a balance adjustment");
        }
        if (
          !row.description.startsWith(ADJ_DESC_PREFIX) ||
          row.description.startsWith(MANUAL_WD_DESC_PREFIX)
        ) {
          throw new Error("WIPE_GUARD: a selected row is not a genuine admin adjustment");
        }
        if (row.status !== "completed") {
          throw new Error("WIPE_GUARD: a selected row is not a completed adjustment");
        }
      }

      // Snapshot the full rows (Decimal/Date serialized later) + compute
      // the signed sum to reverse off the balance.
      deletedRows = rows as unknown as Array<Record<string, unknown>>;
      totalRemoved = rows.reduce((acc, r) => acc + toNumber(r.amount), 0);

      // 2. Delete EXACTLY these ids, re-scoped by the same guard predicate
      //    so the DELETE itself can't touch anything outside the verified
      //    set even under a race. deletedCount must equal ids.length.
      const del = await tx.ledger_transactions.deleteMany({
        where: {
          id: { in: ids },
          user_id: parsed.userId,
          type: ADJ_TYPE,
          status: "completed",
          description: { startsWith: ADJ_DESC_PREFIX },
        },
      });
      if (del.count !== ids.length) {
        // Predicate mismatch between the read and the delete → abort the
        // whole tx so nothing is half-deleted.
        throw new Error("WIPE_GUARD: delete count mismatch — refresh and retry");
      }

      // 3. Reduce available_balance by the summed amount (reverse of how
      //    adjustBalance adds it). Optimistic-locked on version. We clamp
      //    at 0 — never drive the spendable balance negative (a wager
      //    balance check elsewhere would misbehave). The clamp is recorded
      //    so the audit event surfaces any shortfall.
      const b = await tx.balances.findUnique({ where: { user_id: parsed.userId } });
      if (!b) throw new Error("User balances not found");

      balanceBefore = toNumber(b.available_balance);
      const reduced = balanceBefore - totalRemoved;
      balanceAfter = reduced < 0 ? 0 : reduced;

      const updated = await tx.balances.updateMany({
        where: { user_id: parsed.userId, version: b.version },
        data: {
          available_balance: balanceAfter,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (
      message.startsWith("WIPE_GUARD:") ||
      message === "User balances not found" ||
      message.includes("concurrently")
    ) {
      // Surface the actionable guard message verbatim (prefix stripped).
      return { success: false, error: message.replace(/^WIPE_GUARD:\s*/, "") };
    }
    console.error("[wipeBalanceAdjustments] transaction failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing was deleted)" };
  }

  // 4. Persist the recovery snapshot. The main-DB tx is already committed,
  //    so a snapshot failure here would leave the rows deleted but
  //    unrecoverable — unacceptable. We compensate by re-inserting the
  //    deleted rows + re-adding the balance (best-effort rollback) and
  //    reporting failure. This window is tiny and only hit if the admin DB
  //    dies between the two commits.
  const userMeta = await db.user
    .findUnique({
      where: { id: parsed.userId },
      select: { username: true, email: true },
    })
    .catch(() => null);

  const snapshot: BalanceAdjustmentWipeSnapshot = {
    userId: parsed.userId,
    rows: deletedRows,
  };

  try {
    await adminDb.admin_balance_adjustment_wipes.create({
      data: {
        user_id: parsed.userId,
        username: userMeta?.username ?? null,
        email: userMeta?.email ?? null,
        wiped_by: session.userId,
        total_amount: totalRemoved,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        adjustment_count: deletedRows.length,
        snapshot: wipeSnapshotToJsonValue(snapshot) as Prisma.InputJsonValue,
      },
    });
  } catch (snapErr) {
    console.error(
      "[wipeBalanceAdjustments] snapshot insert failed — rolling back the main-DB delete:",
      snapErr,
    );
    // Compensating re-insert + balance restore so the deletion isn't lost.
    try {
      await db.$transaction(async (tx) => {
        await tx.ledger_transactions.createMany({
          data: deletedRows as unknown as Prisma.ledger_transactionsCreateManyInput[],
          skipDuplicates: true,
        });
        const b = await tx.balances.findUnique({ where: { user_id: parsed.userId } });
        if (b) {
          await tx.balances.updateMany({
            where: { user_id: parsed.userId, version: b.version },
            data: {
              available_balance: toNumber(b.available_balance) + totalRemoved,
              version: { increment: 1 },
            },
          });
        }
      });
      return {
        success: false,
        error: "Recovery snapshot failed — the wipe was rolled back (no rows deleted)",
      };
    } catch (rollbackErr) {
      console.error(
        "[wipeBalanceAdjustments] CRITICAL: snapshot AND rollback both failed — rows deleted without snapshot:",
        rollbackErr,
      );
      // We still audit-log the deletion below so the ids are recoverable
      // from the audit event metadata even without the snapshot row.
      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "balance_adjustments_wiped_snapshot_failed",
        targetUserId: parsed.userId,
        metadata: {
          deletedIds: ids,
          totalRemoved,
          balanceBefore,
          balanceAfter,
          note: "snapshot + rollback both failed; ids preserved here for manual recovery",
        },
      });
      return {
        success: false,
        error:
          "Critical: rows were deleted but the recovery snapshot failed and rollback failed. The deleted ids are recorded in the audit log — contact engineering.",
      };
    }
  }

  // 5. Audit the successful wipe.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "balance_adjustments_wiped",
    targetUserId: parsed.userId,
    metadata: {
      deletedIds: ids,
      deletedCount: deletedRows.length,
      totalRemoved,
      balanceBefore,
      balanceAfter,
      recoverable: true,
      caveat:
        "hard-delete: remaining ledger rows' balance_before/after are not rewritten; current balance corrected",
    },
  });

  revalidatePath(`/users/${parsed.userId}`);
  return {
    success: true,
    deletedCount: deletedRows.length,
    totalRemoved,
    balanceBefore,
    balanceAfter,
  };
}

const restoreSchema = z.object({
  wipeId: z.string().uuid("Invalid wipe id"),
  totpCode: z.string().min(1, "2FA code is required"),
});

/**
 * Restore a wipe batch: re-insert the snapshotted ledger rows back into the
 * main DB and re-add the summed amount to the user's balance. Mirrors
 * /users/deleted restoreDeletedUser. Idempotent-guarded: a batch already
 * marked restored_at cannot be restored again (double-insert / double-credit).
 */
export async function restoreBalanceAdjustmentWipe(
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

  await ensureBalanceAdjustmentWipesSchema();

  const wipe = await adminDb.admin_balance_adjustment_wipes.findUnique({
    where: { id: parsed.data.wipeId },
  });
  if (!wipe) return { success: false, error: "Wipe batch not found" };
  if (wipe.restored_at) {
    return { success: false, error: "This wipe has already been restored" };
  }

  const snapshot = wipe.snapshot as unknown as BalanceAdjustmentWipeSnapshot;
  if (!snapshot || !Array.isArray(snapshot.rows) || !snapshot.userId) {
    return { success: false, error: "Snapshot is malformed — cannot restore" };
  }
  const totalAmount = toNumber(wipe.total_amount);

  const db = await getDb();

  try {
    await db.$transaction(async (tx) => {
      // Re-insert the rows verbatim. createMany + Unchecked input (scalar
      // columns only) mirrors the deleted-users restore. skipDuplicates
      // makes a partial double-run safe (e.g. retried after a timeout).
      // We strip any column that's undefined; the snapshot is pure JSON.
      const rowsForInsert = snapshot.rows.map((r) => {
        const copy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (v === undefined) continue;
          copy[k] = v;
        }
        return copy;
      });

      await tx.ledger_transactions.createMany({
        data: rowsForInsert as unknown as Prisma.ledger_transactionsCreateManyInput[],
        skipDuplicates: true,
      });

      // Re-add the summed amount to the balance (reverse of the wipe's
      // reduction). Optimistic-locked. We do NOT attempt to rewrite the
      // re-inserted rows' historical balance_before/after — they reflect
      // the balance at their ORIGINAL time, same fidelity tradeoff the
      // wipe documented.
      const b = await tx.balances.findUnique({ where: { user_id: snapshot.userId } });
      if (!b) throw new Error("User balances not found");

      const updated = await tx.balances.updateMany({
        where: { user_id: snapshot.userId, version: b.version },
        data: {
          available_balance: toNumber(b.available_balance) + totalAmount,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message === "User balances not found" || message.includes("concurrently")) {
      return { success: false, error: message };
    }
    console.error("[restoreBalanceAdjustmentWipe] transaction failed:", err);
    return { success: false, error: "Restore failed — please try again" };
  }

  // Mark restored so it can't be re-applied.
  await adminDb.admin_balance_adjustment_wipes.update({
    where: { id: parsed.data.wipeId },
    data: { restored_at: new Date(), restored_by: session.userId },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "balance_adjustments_wipe_restored",
    targetUserId: snapshot.userId,
    metadata: {
      wipeId: parsed.data.wipeId,
      restoredCount: snapshot.rows.length,
      totalAmount,
    },
  });

  revalidatePath(`/users/${snapshot.userId}`);
  return { success: true };
}
