"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  MONITOR_CASE_DECISIONS,
  MONITOR_CASE_DECISION_LABELS,
  submitAntifraudCaseDecision,
} from "@/lib/antifraud/monitor-api";

/**
 * The decision leg of the monitor case detail.
 *
 * This is the seam that used to be missing: the monitor service holds all the
 * evidence and already exposes a decision state machine, but nothing in the
 * admin could reach it — an analyst had to re-key the account into the
 * (separate, ADMIN-DB) review queue and leave the monitor case open forever.
 *
 * What happens here:
 *   1. Re-verify workspace access — a server action is its own request.
 *   2. Validate with Zod (`safeParse`), mirroring the service's own bounds so
 *      a bad reason fails with a readable message instead of a 400.
 *   3. POST the verdict to the monitor service with the CLIENT-generated
 *      idempotency key, so a retry can never double-write `staff_actions`.
 *   4. Send the authenticated actor to the service so `staff_actions` names
 *      the human, then mirror the verdict into `admin_audit_events` so the
 *      admin-side audit trail names the same analyst.
 *
 * The prod game DB is never touched: a verdict is a record, not an account
 * mutation. Banning / restricting still happens on the main dashboard.
 */

const decisionSchema = z.object({
  caseId: z.string().uuid("Invalid case id"),
  decision: z.enum(MONITOR_CASE_DECISIONS),
  // Matches the service's own `z.string().trim().min(1).max(1000)`, with a
  // floor that actually asks for a sentence.
  reason: z
    .string()
    .trim()
    .min(4, "Say why you are making this call")
    .max(1000, "Keep the reason under 1000 characters"),
  idempotencyKey: z.string().uuid("Invalid idempotency key"),
});

export async function decideMonitorCase(
  input: unknown,
): Promise<{ idempotent: boolean; label: string }> {
  const session = await requireAntifraudAccess();
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { caseId, decision, reason, idempotencyKey } = parsed.data;

  const result = await submitAntifraudCaseDecision({
    caseId,
    decision,
    reason,
    idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });

  // Audit only the write that actually changed something. A replayed key is a
  // no-op upstream and would otherwise log a phantom second decision.
  if (!result.idempotent) {
    try {
      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "antifraud_monitor_case_decision",
        metadata: { caseId, decision, reason },
      });
    } catch (err) {
      // The verdict is already recorded upstream — a failed audit mirror must
      // not present itself to the analyst as a failed decision.
      console.error(
        "[antifraud-monitor] decision audit mirror failed:",
        err,
      );
    }
  }

  revalidatePath(`/antifraud/monitor/cases/${caseId}`);
  revalidatePath("/antifraud/monitor");

  return {
    idempotent: result.idempotent,
    label: MONITOR_CASE_DECISION_LABELS[decision],
  };
}
