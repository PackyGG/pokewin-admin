"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { updateAntifraudScoreWeight } from "@/lib/antifraud/monitor-api";
import { updateAnalysisRule } from "@/lib/antifraud/network-api";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

const updateSchema = z.object({
  key: z.string().trim().min(1).max(100),
  points: z.number().int().min(-500).max(500),
  idempotencyKey: z.string().uuid(),
});

export async function setAntifraudScoreWeight(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await updateAntifraudScoreWeight({
    ...parsed.data,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_score_weight_updated",
    metadata: {
      key: parsed.data.key,
      points: parsed.data.points,
      idempotencyKey: parsed.data.idempotencyKey,
    },
  });
  revalidatePath("/antifraud/settings");
}

const analysisRuleSchema = z.object({
  key: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  points: z.number().int().min(-500).max(500),
  threshold: z.number().min(0).max(1_000_000),
});

export async function setAntifraudAnalysisRule(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = analysisRuleSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  await updateAnalysisRule({
    ...parsed.data,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_analysis_rule_updated",
    metadata: parsed.data,
  });
  revalidatePath("/antifraud/settings");
}
