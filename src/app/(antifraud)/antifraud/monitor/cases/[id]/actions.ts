"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";

import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_audit_events } from "@/lib/db-schema/admin/schema";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mirror the monitor verdict exactly once.
 *
 * This runs on both a first upstream success and an idempotent replay. If the
 * monitor committed but ADMIN audit delivery failed, retrying the same key
 * repairs the missing mirror. If it already landed, the unique index makes the
 * insert a no-op after which we verify the key is bound to the same command.
 */
async function mirrorDecisionAudit(input: {
  adminUserId: string;
  caseId: string;
  decision: string;
  reason: string;
  idempotencyKey: string;
}): Promise<void> {
  const metadata = {
    caseId: input.caseId,
    decision: input.decision,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  };
  const inserted = await adminDrizzle.insert(admin_audit_events).values({
    admin_user_id: input.adminUserId,
    event_type: "antifraud_monitor_case_decision",
    metadata,
  }).onConflictDoNothing().returning({ id: admin_audit_events.id });
  if (inserted.length > 0) return;

  const [existing] = await adminDrizzle.select({
    adminUserId: admin_audit_events.admin_user_id,
    metadata: admin_audit_events.metadata,
  }).from(admin_audit_events).where(and(
    eq(admin_audit_events.event_type, "antifraud_monitor_case_decision"),
    sql`${admin_audit_events.metadata} ->> 'idempotencyKey' = ${input.idempotencyKey}`,
  )).limit(1);
  const stored = existing?.metadata;
  if (
    !existing ||
    existing.adminUserId !== input.adminUserId ||
    !isRecord(stored) ||
    stored.caseId !== input.caseId ||
    stored.decision !== input.decision ||
    stored.reason !== input.reason
  ) {
    throw new Error(
      "That decision retry key was already used for a different command.",
    );
  }
}

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

  // Always retry the ADMIN mirror, including when the service says this is an
  // exact replay. The audit insert has the same key and is independently
  // idempotent, which repairs partial service-success/audit-failure outcomes.
  await mirrorDecisionAudit({
    adminUserId: session.userId,
    caseId,
    decision,
    reason,
    idempotencyKey,
  });

  revalidatePath(`/antifraud/monitor/cases/${caseId}`);
  revalidatePath("/antifraud/monitor");

  return {
    idempotent: result.idempotent,
    label: MONITOR_CASE_DECISION_LABELS[decision],
  };
}
