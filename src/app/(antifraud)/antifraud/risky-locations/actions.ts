"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createRiskyLocation,
  updateRiskyLocation,
  type RiskyLocation,
} from "@/lib/antifraud/risky-locations-api";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";

const baseSchema = z.object({
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase()),
  monitorDurationMinutes: z.number().int().min(1).max(60),
  idempotencyKey: z.string().uuid(),
  riskWeight: z.number().int().min(0).max(100),
});

const CREATE_REASON = "Added from the risky locations page";
const UPDATE_REASON = "Updated from the risky locations page";

export async function addRiskyLocation(input: unknown): Promise<RiskyLocation> {
  const session = await requireAntifraudAccess();
  const parsed = baseSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const saved = await createRiskyLocation({
    countryCode: parsed.data.countryCode,
    monitorDurationMinutes: parsed.data.monitorDurationMinutes,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
    reason: CREATE_REASON,
    riskWeight: parsed.data.riskWeight,
    expiresAt: null,
  });
  if (!saved.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "antifraud_risky_location_created",
      metadata: {
        countryCode: saved.countryCode,
        monitorDurationMinutes: saved.monitorDurationMinutes,
        reason: CREATE_REASON,
        riskWeight: parsed.data.riskWeight,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
  }
  revalidatePath("/antifraud/risky-locations");
  return saved;
}
const updateSchema = baseSchema.extend({ enabled: z.boolean() });

export async function setRiskyLocation(input: unknown): Promise<RiskyLocation> {
  const session = await requireAntifraudAccess();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const saved = await updateRiskyLocation({
    countryCode: parsed.data.countryCode,
    monitorDurationMinutes: parsed.data.monitorDurationMinutes,
    enabled: parsed.data.enabled,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
    reason: UPDATE_REASON,
    riskWeight: parsed.data.riskWeight,
    expiresAt: null,
  });
  if (!saved.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "antifraud_risky_location_updated",
      metadata: {
        countryCode: saved.countryCode,
        enabled: saved.enabled,
        monitorDurationMinutes: saved.monitorDurationMinutes,
        reason: UPDATE_REASON,
        riskWeight: parsed.data.riskWeight,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
  }
  revalidatePath("/antifraud/risky-locations");
  return saved;
}
