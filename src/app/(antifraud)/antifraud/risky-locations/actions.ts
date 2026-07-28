"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createRiskyLocation,
  updateRiskyLocation,
  type RiskyLocation,
} from "@/lib/antifraud/risky-locations-api";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

const baseSchema = z.object({
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  monitorDurationMinutes: z.number().int().min(1).max(60),
  idempotencyKey: z.string().uuid(),
});

export async function addRiskyLocation(input: unknown): Promise<RiskyLocation> {
  const session = await requireAntifraudManager();
  const parsed = baseSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const saved = await createRiskyLocation({
    ...parsed.data,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  if (!saved.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "antifraud_risky_location_created",
      metadata: {
        countryCode: saved.countryCode,
        monitorDurationMinutes: saved.monitorDurationMinutes,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
  }
  revalidatePath("/antifraud/risky-locations");
  return saved;
}
const updateSchema = baseSchema.extend({ enabled: z.boolean() });

export async function setRiskyLocation(
  input: unknown,
): Promise<RiskyLocation> {
  const session = await requireAntifraudManager();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const saved = await updateRiskyLocation({
    ...parsed.data,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  if (!saved.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "antifraud_risky_location_updated",
      metadata: {
        countryCode: saved.countryCode,
        enabled: saved.enabled,
        monitorDurationMinutes: saved.monitorDurationMinutes,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
  }
  revalidatePath("/antifraud/risky-locations");
  return saved;
}
