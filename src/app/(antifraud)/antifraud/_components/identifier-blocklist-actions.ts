"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createIdentifierBlocklistRule,
  identifierBlocklistKindSchema,
  updateIdentifierBlocklistRule,
} from "@/lib/antifraud/identifier-blocklists-api";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";

const commonSchema = z.object({
  kind: identifierBlocklistKindSchema,
  confirmed: z.literal(true),
  idempotencyKey: z.string().uuid(),
});
// The monitor API still requires a reason and an expiry field on every
// mutation, but the panel no longer collects them: rules are permanent and the
// admin audit event carries the actor.
const AUTOMATIC_REASON = "Blocked from the antifraud admin panel";
const createSchema = commonSchema.extend({
  value: z.string().trim().min(1).max(255),
  matchMode: z.enum(["exact", "cidr"]),
});
const updateSchema = commonSchema.extend({
  id: z.string().uuid(),
  enabled: z.boolean(),
});

function revalidate(kind: "ip" | "fingerprint") {
  revalidatePath(
    kind === "ip"
      ? "/antifraud/ip-blacklist"
      : "/antifraud/fingerprint-blacklist",
  );
}

export async function addIdentifierBlocklistRule(input: unknown) {
  const session = await requireAntifraudAccess();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const saved = await createIdentifierBlocklistRule({
    ...parsed.data,
    reason: AUTOMATIC_REASON,
    expiresAt: null,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  if (!saved.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "antifraud_identifier_blocklist_created",
      metadata: {
        blocklistId: saved.id,
        kind: saved.kind,
        value: saved.value,
        matchMode: saved.matchMode,
        affectedUsers: saved.affectedUsers,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
  }
  revalidate(saved.kind);
  return saved;
}

export async function setIdentifierBlocklistRuleState(input: unknown) {
  const session = await requireAntifraudAccess();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const saved = await updateIdentifierBlocklistRule({
    ...parsed.data,
    reason: AUTOMATIC_REASON,
    expiresAt: null,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  if (!saved.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: saved.enabled
        ? "antifraud_identifier_blocklist_reactivated"
        : "antifraud_identifier_blocklist_disabled",
      metadata: {
        blocklistId: saved.id,
        kind: saved.kind,
        value: saved.value,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
  }
  revalidate(saved.kind);
  return saved;
}
