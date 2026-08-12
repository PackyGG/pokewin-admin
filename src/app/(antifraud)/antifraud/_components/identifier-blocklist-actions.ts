"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createIdentifierBlocklistRule,
  identifierBlocklistKindSchema,
  updateIdentifierBlocklistRule,
  type IdentifierBlocklistRule,
} from "@/lib/antifraud/identifier-blocklists-api";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { antifraudActionResult } from "@/lib/antifraud/action-error-message";
import { fail, type ServerActionResult } from "@/lib/errors/server-action-result";

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
  effect: z.enum(["block", "known_vpn"]),
});

/**
 * A UI success here has to follow authoritative confirmation, never a bare
 * HTTP 200. The monitor echoes the stored rule back, so before reporting
 * success we check that the echo is the rule we asked about — the audit event
 * and the revalidate below both key off `saved`, so an echo for a different
 * row would log and refresh the wrong one, and the operator would be told a
 * change landed that did not. UUIDs are compared case-insensitively so a
 * non-canonical casing on the way in cannot fail a change that did apply.
 */
function assertMonitorEchoedRule(
  saved: IdentifierBlocklistRule,
  requested: { id: string; kind: IdentifierBlocklistRule["kind"] },
): void {
  if (
    saved.id.toLowerCase() !== requested.id.toLowerCase()
    || saved.kind !== requested.kind
  ) {
    throw new Error("The Antifraud monitor has not applied this change yet.");
  }
}

function revalidate(kind: "ip" | "fingerprint") {
  revalidatePath(
    kind === "ip"
      ? "/antifraud/ip-blacklist"
      : "/antifraud/fingerprint-blacklist",
  );
}

export async function addIdentifierBlocklistRule(input: unknown): Promise<ServerActionResult<IdentifierBlocklistRule>> {
  const session = await requireAntifraudAccess();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  return antifraudActionResult("antifraud.identifierBlocklist.add", "The rule could not be added.", async () => {
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
  });
}

export async function setIdentifierBlocklistRuleEffect(input: unknown): Promise<ServerActionResult<IdentifierBlocklistRule>> {
  const session = await requireAntifraudAccess();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  if (parsed.data.kind !== "ip") return fail("Only IP rules can be known VPNs.");
  return antifraudActionResult("antifraud.identifierBlocklist.effect", "The policy could not be changed.", async () => {
  const saved = await updateIdentifierBlocklistRule({
    ...parsed.data,
    reason: AUTOMATIC_REASON,
    expiresAt: null,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  assertMonitorEchoedRule(saved, parsed.data);
  if (saved.effect !== parsed.data.effect) {
    throw new Error("The Antifraud monitor has not applied this policy yet.");
  }
  if (!saved.idempotent) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: parsed.data.effect === "known_vpn"
        ? "antifraud_identifier_marked_known_vpn"
        : "antifraud_identifier_restored_blocking",
      metadata: {
        blocklistId: saved.id,
        kind: saved.kind,
        value: saved.value,
        effect: saved.effect,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
  }
  revalidate(saved.kind);
  return saved;
  });
}

export async function setIdentifierBlocklistRuleState(input: unknown): Promise<ServerActionResult<IdentifierBlocklistRule>> {
  const session = await requireAntifraudAccess();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  return antifraudActionResult("antifraud.identifierBlocklist.state", "The rule could not be changed.", async () => {
  const saved = await updateIdentifierBlocklistRule({
    ...parsed.data,
    reason: AUTOMATIC_REASON,
    expiresAt: null,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
    effect: parsed.data.effect,
  });
  assertMonitorEchoedRule(saved, parsed.data);
  // The PUT carries `effect` as well, so the confirmation covers the whole
  // requested state, not just the enabled flag.
  if (
    saved.enabled !== parsed.data.enabled
    || saved.effect !== parsed.data.effect
  ) {
    throw new Error("The Antifraud monitor has not applied this change yet.");
  }
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
  });
}
