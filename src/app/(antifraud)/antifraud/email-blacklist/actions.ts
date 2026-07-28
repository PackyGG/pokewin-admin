"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createFiatEmailDomain,
  updateFiatEmailDomain,
  type FiatEmailDomainRule,
} from "@/lib/antifraud/fiat-email-domains-api";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

const createSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  idempotencyKey: z.string().uuid(),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
  idempotencyKey: z.string().uuid(),
});

function revalidateBlacklistSurfaces(): void {
  revalidatePath("/antifraud/email-blacklist");
  revalidatePath("/antifraud/fiat-deposits");
}

export async function addFiatEmailDomain(
  input: unknown,
): Promise<FiatEmailDomainRule> {
  const session = await requireAntifraudManager();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const saved = await createFiatEmailDomain({
    ...parsed.data,
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
      },
    });
  }
  revalidateBlacklistSurfaces();
  return saved;
}

export async function setFiatEmailDomainState(
  input: unknown,
): Promise<FiatEmailDomainRule> {
  const session = await requireAntifraudManager();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const saved = await updateFiatEmailDomain({
    ...parsed.data,
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
      },
    });
  }
  revalidateBlacklistSurfaces();
  return saved;
}
