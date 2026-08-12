"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import {
  resolveSignupIngestionFailure,
  retrySignupIngestionFailure,
} from "@/lib/antifraud/signup-failures-api";
import { require2FA } from "@/lib/require-2fa";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { antifraudActionResult } from "@/lib/antifraud/action-error-message";
import { fail, type ServerActionResult } from "@/lib/errors/server-action-result";

const baseSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(4).max(500),
  credential: z.string().trim().min(1).max(4_096),
  idempotencyKey: z.string().uuid(),
});

const retrySchema = baseSchema;
const resolveSchema = baseSchema.extend({ confirmation: z.literal("RESOLVE") });

export async function retrySignupFailure(input: unknown): Promise<ServerActionResult> {
  const session = await requireAntifraudManager(
    "Only owners and admins can retry failed signup assessments.",
  );
  const parsed = retrySchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  return antifraudActionResult("antifraud.signupFailures.retry", "The signup retry could not be queued.", async () => {
  await require2FA(session.userId, parsed.data.credential);

  const saved = await retrySignupIngestionFailure({
    userId: parsed.data.userId,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
    reason: parsed.data.reason,
  });
  if (!saved.idempotent) {
    await mirrorRecoveryAudit({
      adminUserId: session.userId,
      eventType: "antifraud_signup_ingestion_retried",
      userId: parsed.data.userId,
      reason: parsed.data.reason,
      idempotencyKey: parsed.data.idempotencyKey,
    });
  }
  revalidateHealth();
  });
}

export async function resolveSignupFailure(input: unknown): Promise<ServerActionResult> {
  const session = await requireAntifraudManager(
    "Only owners and admins can resolve failed signup assessments.",
  );
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  return antifraudActionResult("antifraud.signupFailures.resolve", "The signup failure could not be resolved.", async () => {
  await require2FA(session.userId, parsed.data.credential);

  const saved = await resolveSignupIngestionFailure({
    userId: parsed.data.userId,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
    reason: parsed.data.reason,
  });
  if (!saved.idempotent) {
    await mirrorRecoveryAudit({
      adminUserId: session.userId,
      eventType: "antifraud_signup_ingestion_resolved",
      userId: parsed.data.userId,
      reason: parsed.data.reason,
      idempotencyKey: parsed.data.idempotencyKey,
    });
  }
  revalidateHealth();
  });
}

function revalidateHealth(): void {
  revalidatePath("/antifraud/settings");
}

async function mirrorRecoveryAudit(input: {
  adminUserId: string;
  eventType:
    | "antifraud_signup_ingestion_retried"
    | "antifraud_signup_ingestion_resolved";
  userId: string;
  reason: string;
  idempotencyKey: string;
}): Promise<void> {
  try {
    const outcome = await createAdminAuditEventDurable({
      adminUserId: input.adminUserId,
      eventType: input.eventType,
      targetUserId: input.userId,
      metadata: {
        source: "antifraud_settings_health",
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (outcome.status === "lost") {
      console.error("[signup-recovery] secondary admin audit was lost", outcome.error);
    }
  } catch (error) {
    // The monitor mutation and its service_audit_events row are already
    // committed. Never invite a duplicate operator action because the
    // dashboard's secondary audit mirror is temporarily unavailable.
    console.error("[signup-recovery] secondary admin audit failed", error);
  }
}
