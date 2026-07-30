"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  FIAT_PERK_SCOPES,
  MAX_PERK_RUN_ACCOUNTS,
  decideFiatPerkCandidate,
  revokeFiatPerkGrant,
  startFiatPerkRun,
  type FiatPerkCandidate,
  type FiatPerkGrant,
  type FiatPerkRun,
} from "@/lib/antifraud/fiat-perks-api";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

/**
 * Fiat perk decisions hand an account a real money rail, so every action here
 * sits behind the MANAGE gate (owners + admins), carries an idempotency key so
 * a double click cannot double-write, and lands in the admin audit trail.
 */

const runSchema = z.object({
  scope: z.enum(FIAT_PERK_SCOPES),
  minAccountAgeDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .default(DEFAULT_MIN_ACCOUNT_AGE_DAYS),
  limit: z.coerce.number().int().min(1).max(MAX_PERK_RUN_ACCOUNTS).default(200),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter country code.")
    .nullable()
    .default(null),
  activeWithinDays: z.coerce.number().int().min(1).max(365).default(30),
  excludeGranted: z.boolean().default(true),
  idempotencyKey: z.string().uuid(),
});

const decisionSchema = z.object({
  candidateId: z.string().uuid(),
  decision: z.enum(["approved", "declined"]),
  note: z.string().trim().min(1).max(500).nullable().default(null),
  idempotencyKey: z.string().uuid(),
});

const revokeSchema = z.object({
  userId: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(4, "Give a reason of at least 4 characters.")
    .max(500),
  idempotencyKey: z.string().uuid(),
});

function revalidatePerkSurfaces(): void {
  revalidatePath("/antifraud/fiat-perks");
}

export async function startPerkScreeningRun(
  input: unknown,
): Promise<FiatPerkRun> {
  const session = await requireAntifraudManager();
  const parsed = runSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  if (parsed.data.scope === "country" && !parsed.data.countryCode) {
    throw new Error("Pick a country for a country scope.");
  }

  const run = await startFiatPerkRun({
    scope: parsed.data.scope,
    minAccountAgeDays: parsed.data.minAccountAgeDays,
    limit: parsed.data.limit,
    countryCode: parsed.data.countryCode?.toUpperCase() ?? null,
    activeWithinDays: parsed.data.activeWithinDays,
    excludeGranted: parsed.data.excludeGranted,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "fiat_perk_screening_started",
    metadata: {
      runId: run.id,
      scope: run.scope,
      parameters: run.parameters,
      idempotencyKey: parsed.data.idempotencyKey,
    },
  });
  revalidatePerkSurfaces();
  return run;
}

export async function decidePerkCandidate(
  input: unknown,
): Promise<FiatPerkCandidate> {
  const session = await requireAntifraudManager();
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const candidate = await decideFiatPerkCandidate({
    candidateId: parsed.data.candidateId,
    decision: parsed.data.decision,
    note: parsed.data.note,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType:
      parsed.data.decision === "approved"
        ? "fiat_perk_granted"
        : "fiat_perk_declined",
    targetUserId: candidate.userId,
    metadata: {
      candidateId: candidate.id,
      runId: candidate.runId,
      verdict: candidate.verdict,
      riskScore: candidate.riskScore,
      blockingReasons: candidate.blockingReasons,
      note: parsed.data.note,
      idempotencyKey: parsed.data.idempotencyKey,
    },
  });
  revalidatePerkSurfaces();
  return candidate;
}

export async function revokePerkGrant(input: unknown): Promise<FiatPerkGrant> {
  const session = await requireAntifraudManager();
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const grant = await revokeFiatPerkGrant({
    userId: parsed.data.userId,
    reason: parsed.data.reason,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "fiat_perk_revoked",
    targetUserId: grant.userId,
    metadata: {
      reason: parsed.data.reason,
      idempotencyKey: parsed.data.idempotencyKey,
    },
  });
  revalidatePerkSurfaces();
  return grant;
}
