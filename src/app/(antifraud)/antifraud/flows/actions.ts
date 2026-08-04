"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createAntifraudRule,
  updateAntifraudRule,
  type AntifraudBehaviorRule,
} from "@/lib/antifraud/monitor-api";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

const flowSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500),
  enabled: z.boolean(),
  sequence: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  excludeBefore: z.array(z.string().trim().min(1).max(100)).max(20),
  windowSeconds: z.number().int().min(1).max(86_400),
  scoreDelta: z.number().int().min(-500).max(500),
  actionType: z.literal("manual_review"),
  idempotencyKey: z.string().uuid(),
});

export async function saveAntifraudFlow(
  input: unknown,
): Promise<AntifraudBehaviorRule> {
  const session = await requireAntifraudManager();
  const parsed = flowSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { id, ...data } = parsed.data;
  const mutation = {
    ...data,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  };
  const saved = id
    ? await updateAntifraudRule(id, mutation)
    : await createAntifraudRule(mutation);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: id ? "antifraud_flow_updated" : "antifraud_flow_created",
    metadata: {
      flowId: saved.id,
      flowKey: saved.key,
      enabled: saved.enabled,
      sequence: saved.sequence,
      excludeBefore: saved.exclude_before,
      windowSeconds: saved.window_seconds,
      scoreDelta: saved.score_delta,
      actionType: saved.action_type,
      idempotencyKey: data.idempotencyKey,
    },
  });
  revalidatePath("/antifraud/settings");
  revalidatePath("/antifraud/monitor");
  return saved;
}
