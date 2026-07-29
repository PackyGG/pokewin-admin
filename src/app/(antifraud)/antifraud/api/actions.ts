"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  resolveSignupIngestionFailure,
  retrySignupIngestionFailure,
} from "@/lib/antifraud/signup-failures-api";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

const mutationSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

async function mutate(
  action: "retry" | "resolve",
  input: unknown,
): Promise<{ success: true }> {
  const session = await requireAntifraudManager();
  const parsed = mutationSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const result =
    action === "retry"
      ? await retrySignupIngestionFailure({
          ...parsed.data,
          actorId: session.userId,
          actorUsername: session.username,
        })
      : await resolveSignupIngestionFailure({
          ...parsed.data,
          actorId: session.userId,
          actorUsername: session.username,
        });
  if (!result.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType:
        action === "retry"
          ? "antifraud_signup_failure_retried"
          : "antifraud_signup_failure_resolved",
      targetUserId: parsed.data.userId,
      metadata: {
        reason: parsed.data.reason,
        idempotencyKey: parsed.data.idempotencyKey,
        failureCount: result.failureCount,
      },
    });
  }
  revalidatePath("/antifraud/api");
  return { success: true };
}

export async function retrySignupFailureAction(
  input: unknown,
): Promise<{ success: true }> {
  return await mutate("retry", input);
}

export async function resolveSignupFailureAction(
  input: unknown,
): Promise<{ success: true }> {
  return await mutate("resolve", input);
}
