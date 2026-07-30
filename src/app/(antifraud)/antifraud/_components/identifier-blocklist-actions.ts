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
  reason: z.string().trim().min(4).max(500),
  expiresAt: z.string().datetime().nullable(),
  confirmed: z.literal(true),
  idempotencyKey: z.string().uuid(),
});
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
        reason: parsed.data.reason,
        expiresAt: parsed.data.expiresAt,
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
        reason: parsed.data.reason,
        expiresAt: parsed.data.expiresAt,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
  }
  revalidate(saved.kind);
  return saved;
}
