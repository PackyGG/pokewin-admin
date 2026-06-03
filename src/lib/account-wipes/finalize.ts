import "server-only";

import { adminDb } from "@/lib/admin-db";
import type { Prisma } from "@/generated/admin-prisma/client";

/**
 * finalize.ts — the dual-DB audit-CONSISTENCY layer shared by every wipe
 * action (balance / vault / inventory / deposits in
 * wipe-account-targets-actions.ts + wipe-deposits-actions.ts, and the
 * adjustments wipe in wipe-adjustments-actions.ts).
 *
 * ─── THE PROBLEM THIS FIXES ──────────────────────────────────────────────
 *
 * A wipe deletes from the MAIN game DB (`db`), but BOTH the recovery snapshot
 * AND the admin audit event are written to the ADMIN DB (`adminDb`). A main-DB
 * `db.$transaction` and an admin-DB write CANNOT be made atomic together —
 * they are two different databases. Previously each action wrote the snapshot
 * first, ran the destructive main-DB tx, and THEN called
 * `createAdminAuditEvent(...)` as a separate, best-effort admin-DB write. If
 * that post-commit audit write threw / was interrupted, the result was a
 * COMMITTED wipe with a snapshot row but NO audit-trail row — a real
 * occurrence (a 678-row inventory wipe snapshot with no matching
 * admin_audit_events row), and a state you cannot reconcile from the audit
 * trail.
 *
 * ─── THE FIX (the key insight) ───────────────────────────────────────────
 *
 * The snapshot row AND the audit event are BOTH in the admin DB, so they CAN
 * be written together in ONE `adminDb.$transaction([...])`. Combined with a
 * lifecycle `status` column on the snapshot row, the flow becomes:
 *
 *   1. Write the snapshot with status = 'pending' BEFORE the main-DB delete
 *      (unchanged snapshot-first recoverability — the recovery copy exists
 *      before anything is destroyed).
 *   2. Run the destructive main-DB `db.$transaction` EXACTLY as before
 *      (unchanged delete logic + optimistic lock + count verification).
 *   3. On success → `finalizeWipeSuccess`: in ONE admin-DB transaction, set
 *      the snapshot status → 'completed' AND insert the audit event. Because
 *      both writes commit atomically, "committed delete ⇒ audit present"
 *      holds reliably (there is no window where one lands without the other).
 *   4. On main-DB delete failure → `markWipeFailed`: set the snapshot status
 *      → 'failed' (the delete did NOT happen, so the snapshot must never be a
 *      spurious 'completed' with an audit row). A 'failed' row is a terminal,
 *      clearly-detectable marker that restore refuses — strictly safer than
 *      silently deleting the orphan snapshot.
 *
 * RESILIENCE: `finalizeWipeSuccess` retries the admin-DB transaction a few
 * times (the main-DB delete has ALREADY committed — we must not give up
 * easily). If every attempt fails, the snapshot is LEFT in 'pending' (NOT
 * silently missing) and a CRITICAL line is logged with the wipe id so the
 * incomplete-but-detectable state can be reconciled by hand. The failure is
 * never swallowed: the caller is told finalize failed (the wipe itself is
 * still committed and recoverable — the snapshot exists).
 */

/** Lifecycle status values for a wipe snapshot row (both wipe stores). */
export const WIPE_STATUS = {
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type WipeStatus = (typeof WIPE_STATUS)[keyof typeof WIPE_STATUS];

/** Which admin-DB snapshot store a wipe lives in. */
export type WipeStore = "account" | "adjustments";

/** The audit-event payload written atomically alongside the status flip. */
export type WipeAuditEvent = {
  adminUserId: string;
  eventType: string;
  targetUserId: string;
  /** Best-effort request IP, resolved by the caller BEFORE the tx (see resolveRequestIp). */
  ip: string | null;
  metadata: Record<string, unknown>;
};

/**
 * Resolve the request IP exactly like createAdminAuditEvent does, so the audit
 * row written inside finalize carries the same best-effort IP. Done OUTSIDE
 * the transaction because `headers()` only works in a request scope and we
 * keep the admin-DB transaction as short as possible. Never throws.
 */
export async function resolveRequestIp(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    return (
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      null
    );
  } catch {
    return null;
  }
}

/** How many times finalize retries the admin-DB transaction after a committed delete. */
const FINALIZE_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Atomically (within ONE admin-DB transaction) flip the wipe snapshot row's
 * status → 'completed' AND insert the audit event. Call this ONLY after the
 * destructive main-DB delete has COMMITTED.
 *
 * Retries the transaction up to FINALIZE_MAX_ATTEMPTS times. Returns
 * `{ ok: true }` on success. If every attempt fails it leaves the snapshot in
 * 'pending' (detectable, never silently missing), logs a CRITICAL line with
 * the wipe id, and returns `{ ok: false }` — the caller surfaces this; the
 * wipe stays committed + recoverable (the snapshot exists).
 */
export async function finalizeWipeSuccess(params: {
  store: WipeStore;
  wipeId: string;
  audit: WipeAuditEvent;
}): Promise<{ ok: true } | { ok: false }> {
  const { store, wipeId, audit } = params;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= FINALIZE_MAX_ATTEMPTS; attempt++) {
    try {
      await adminDb.$transaction(async (tx) => {
        if (store === "account") {
          const updated = await tx.admin_account_wipes.updateMany({
            where: { id: wipeId, status: WIPE_STATUS.PENDING },
            data: { status: WIPE_STATUS.COMPLETED },
          });
          if (updated.count !== 1) {
            // Either already finalized by a prior (retried) attempt, or the
            // row vanished — abort this attempt's tx without writing a second
            // audit row. A genuine "already completed" is treated as success
            // by the post-loop verification below; a missing row throws.
            throw new Error("WIPE_FINALIZE_STATUS_NOT_PENDING");
          }
        } else {
          const updated = await tx.admin_balance_adjustment_wipes.updateMany({
            where: { id: wipeId, status: WIPE_STATUS.PENDING },
            data: { status: WIPE_STATUS.COMPLETED },
          });
          if (updated.count !== 1) {
            throw new Error("WIPE_FINALIZE_STATUS_NOT_PENDING");
          }
        }

        await tx.admin_audit_events.create({
          data: {
            admin_user_id: audit.adminUserId,
            event_type: audit.eventType,
            target_user_id: audit.targetUserId,
            ip: audit.ip,
            metadata: audit.metadata as Prisma.InputJsonValue,
          },
        });
      });
      return { ok: true };
    } catch (err) {
      lastErr = err;
      // A "not pending" error means a previous attempt in THIS call already
      // committed the status flip + audit row (the tx is atomic, so if the
      // status is no longer pending the audit row was written with it). That
      // is success, not a failure — stop retrying.
      if (
        err instanceof Error &&
        err.message === "WIPE_FINALIZE_STATUS_NOT_PENDING"
      ) {
        const stillPending = await isStillPending(store, wipeId).catch(
          () => true,
        );
        if (!stillPending) return { ok: true };
        // Row is missing/odd — do not loop forever on a non-retryable state.
        break;
      }
      if (attempt < FINALIZE_MAX_ATTEMPTS) {
        await sleep(attempt === 1 ? 150 : 600);
      }
    }
  }

  // Every attempt failed AND the row is still pending (or unverifiable). The
  // main-DB delete is already committed; we must NOT lose the audit silently.
  // Leave the snapshot 'pending' (detectable) and log CRITICAL with the id.
  console.error(
    `[finalizeWipeSuccess] CRITICAL: main-DB delete committed but the admin-DB finalize (status→completed + audit event) failed after ${FINALIZE_MAX_ATTEMPTS} attempts for ${store} wipe`,
    wipeId,
    `— snapshot is LEFT in 'pending' (NOT silently missing); reconcile by hand. Audit event type:`,
    audit.eventType,
    `last error:`,
    lastErr,
  );
  return { ok: false };
}

/** Read the current status of a wipe row; true if still 'pending'. */
async function isStillPending(
  store: WipeStore,
  wipeId: string,
): Promise<boolean> {
  if (store === "account") {
    const row = await adminDb.admin_account_wipes.findUnique({
      where: { id: wipeId },
      select: { status: true },
    });
    return row?.status === WIPE_STATUS.PENDING;
  }
  const row = await adminDb.admin_balance_adjustment_wipes.findUnique({
    where: { id: wipeId },
    select: { status: true },
  });
  return row?.status === WIPE_STATUS.PENDING;
}

/**
 * Mark a wipe snapshot row 'failed' because the destructive main-DB delete
 * failed / rolled back (NOTHING was deleted). Replaces the old "delete the
 * orphan snapshot" cleanup: keeping the row in a terminal 'failed' state is
 * strictly more reconcilable than a vanished row, and restore refuses any
 * non-'completed' row, so a 'failed' snapshot can never be re-applied to
 * credit money/items that were never removed.
 *
 * Best-effort + never throws: the main-DB tx already rolled back (the user's
 * data is intact), so a failed status-write must not mask the original error.
 * Logs CRITICAL with the wipe id if even this fails (so the leftover 'pending'
 * row — which restore still refuses — is visible for manual cleanup).
 */
export async function markWipeFailed(
  store: WipeStore,
  wipeId: string,
): Promise<void> {
  try {
    if (store === "account") {
      await adminDb.admin_account_wipes.updateMany({
        where: { id: wipeId, status: WIPE_STATUS.PENDING },
        data: { status: WIPE_STATUS.FAILED },
      });
    } else {
      await adminDb.admin_balance_adjustment_wipes.updateMany({
        where: { id: wipeId, status: WIPE_STATUS.PENDING },
        data: { status: WIPE_STATUS.FAILED },
      });
    }
  } catch (err) {
    console.error(
      `[markWipeFailed] CRITICAL: could not mark ${store} wipe`,
      wipeId,
      "as 'failed' after a rolled-back main-DB delete — the snapshot stays 'pending' (restore still refuses any non-'completed' row; nothing was deleted, so do NOT restore it):",
      err,
    );
  }
}
