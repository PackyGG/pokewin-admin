"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createFiatEmailDomain,
  updateFiatEmailDomain,
  type FiatEmailDomainRule,
} from "@/lib/antifraud/fiat-email-domains-api";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";

const createSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  confirmed: z.literal(true),
  idempotencyKey: z.string().uuid(),
});

const EMAIL_BLACKLIST_CREATE_REASON = "Added from the email blacklist";

const updateSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
  reason: z.string().trim().min(4).max(500),
  expiresAt: z.string().datetime().nullable(),
  confirmed: z.literal(true),
  idempotencyKey: z.string().uuid(),
});

function revalidateBlacklistSurfaces(): void {
  revalidatePath("/antifraud/email-blacklist");
  revalidatePath("/antifraud/fiat-deposits");
}

export async function addFiatEmailDomain(
  input: unknown,
): Promise<FiatEmailDomainRule> {
  const session = await requireAntifraudAccess();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const saved = await createFiatEmailDomain({
    domain: parsed.data.domain,
    reason: EMAIL_BLACKLIST_CREATE_REASON,
    expiresAt: null,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  if (!saved.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "fiat_email_domain_blacklisted",
      metadata: {
        ruleId: saved.id,
        domain: saved.domain,
        idempotencyKey: parsed.data.idempotencyKey,
        reason: EMAIL_BLACKLIST_CREATE_REASON,
        expiresAt: null,
      },
    });
  }
  revalidateBlacklistSurfaces();
  return saved;
}

export async function setFiatEmailDomainState(
  input: unknown,
): Promise<FiatEmailDomainRule> {
  const session = await requireAntifraudAccess();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const saved = await updateFiatEmailDomain({
    id: parsed.data.id,
    enabled: parsed.data.enabled,
    reason: parsed.data.reason,
    expiresAt: parsed.data.expiresAt,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  if (!saved.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: saved.enabled
        ? "fiat_email_domain_blacklist_enabled"
        : "fiat_email_domain_blacklist_disabled",
      metadata: {
        ruleId: saved.id,
        domain: saved.domain,
        idempotencyKey: parsed.data.idempotencyKey,
        reason: parsed.data.reason,
        expiresAt: parsed.data.expiresAt,
      },
    });
  }
  revalidateBlacklistSurfaces();
  return saved;
}
