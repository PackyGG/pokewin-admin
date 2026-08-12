"use server";

import { sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  beginAntifraudAction,
  finishAntifraudAction,
} from "@/lib/antifraud/security-audit";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { require2FA } from "@/lib/require-2fa";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { requireCapability } from "@/lib/require-capability";
import { resolveAdminMainUserId } from "@/lib/resolve-admin-main-user-id";
import { userDetailTag } from "@/lib/queries/users-detail-cache";
import {
  blockKnownUserIdentifiers,
  type UserIdentifierBlockResult,
} from "@/lib/antifraud/user-identifier-blocking";
import { antifraudActionResult } from "@/lib/antifraud/action-error-message";
import { fail, type ServerActionResult } from "@/lib/errors/server-action-result";

const schema = z.object({
  userId: z.string().trim().min(1).max(100),
  action: z.enum(["ban", "unban"]),
  reason: z.string().trim().min(4).max(500),
  credential: z.string().trim().min(1).max(4_096),
  confirmed: z.literal(true),
  idempotencyKey: z.string().uuid(),
});

export async function mutateBannedUser(input: unknown): Promise<ServerActionResult> {
  const session = await requireAntifraudAccess();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  return antifraudActionResult("antifraud.bannedUsers.mutate", "The account action could not be completed.", async () => {
  // Same capability every other ban path requires (/users actions, antifraud
  // review quick actions) — antifraud page access alone is not enough.
  await requireCapability(
    session,
    "__can_ban_users",
    parsed.data.action === "ban" ? "ban users" : "unban users",
  );
  await require2FA(session.userId, parsed.data.credential);
  const roles = [...new Set([session.role, ...(session.roles ?? [])])];
  const correlationId = await beginAntifraudAction({
    actorAdminUserId: session.userId,
    actorRoles: roles,
    sessionRef: `${session.userId}:${session.iat ?? 0}`,
    action: `antifraud.account.${parsed.data.action}`,
    targetType: "user",
    targetId: parsed.data.userId,
    idempotencyKey: parsed.data.idempotencyKey,
    metadata: { reasonCode: "operator_blocklist_workspace" },
    limitPerMinute: 20,
  });
  // Declared out here so the failure path can report the obligation too: it is
  // committed before the guarded ban UPDATE and is deliberately never rolled
  // back with it (see user-identifier-blocking.ts).
  let identifiers: UserIdentifierBlockResult | null = null;
  try {
    const db = await getPrimaryDrizzleDb();
    const issuerMainUserId = await resolveAdminMainUserId(session.userId);
    identifiers =
      parsed.data.action === "ban"
        ? await blockKnownUserIdentifiers({
            db,
            userId: parsed.data.userId,
            reason: parsed.data.reason,
            actorId: session.userId,
            actorUsername: session.username ?? undefined,
          })
        : null;
    const updated =
      parsed.data.action === "ban"
        ? await db.transaction(async (tx) => {
            const result = await tx.execute<{ id: string }>(sql`
              UPDATE "user"
              SET is_banned=TRUE,banned_reason=${parsed.data.reason},
                banned_at=NOW(),banned_by=${issuerMainUserId},updated_at=NOW()
              WHERE id=${parsed.data.userId} AND is_banned=FALSE
              RETURNING id
            `);
            if (result.rows.length > 0) {
              await tx.execute(
                sql`DELETE FROM session WHERE "userId"=${parsed.data.userId}`,
              );
            }
            return result.rows.length;
          })
        : (
            await db.execute<{ id: string }>(sql`
              UPDATE "user"
              SET is_banned=FALSE,banned_reason=NULL,banned_at=NULL,
                banned_by=NULL,updated_at=NOW()
              WHERE id=${parsed.data.userId} AND is_banned=TRUE
              RETURNING id
            `)
          ).rows.length;
    if (updated === 0) {
      // The identifier obligation above is already durable and the retry
      // worker will apply it whatever this UPDATE did, so reporting only
      // "already banned" left the operator believing nothing happened while
      // shared IPs/fingerprints were on their way to a permanent block.
      const queuedIdentifiers =
        (identifiers?.ipCount ?? 0) + (identifiers?.fingerprintCount ?? 0);
      throw new Error(
        parsed.data.action === "ban"
          ? queuedIdentifiers > 0
            ? "The account is already banned or no longer exists. Its known IP/fingerprint identifiers were already queued for blocking and will still be applied."
            : "The account is already banned or no longer exists."
          : "The account is already unbanned or no longer exists.",
      );
    }
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType:
        parsed.data.action === "ban" ? "account_banned" : "account_unbanned",
      targetUserId: parsed.data.userId,
      metadata: {
        source: "antifraud_banned_users",
        reason: parsed.data.reason,
        correlationId,
        idempotencyKey: parsed.data.idempotencyKey,
        issuer_main_user_id: issuerMainUserId,
        ...(identifiers
          ? {
              blacklisted_ip_count: identifiers.ipCount,
              blacklisted_fingerprint_count: identifiers.fingerprintCount,
              blocklist_changes: identifiers.changedCount,
              identifier_delivery_status: identifiers.deliveryStatus,
              identifier_operation_id: identifiers.operationId,
            }
          : {}),
      },
    });
    await finishAntifraudAction({
      correlationId,
      actorAdminUserId: session.userId,
      actorRoles: roles,
      sessionRef: `${session.userId}:${session.iat ?? 0}`,
      action: `antifraud.account.${parsed.data.action}`,
      outcome: "succeeded",
      targetType: "user",
      targetId: parsed.data.userId,
      idempotencyKey: parsed.data.idempotencyKey,
      metadata: { reasonCode: "operator_blocklist_workspace" },
    });
    revalidatePath("/antifraud/banned-users");
    revalidateTag("users-list");
    revalidateTag("users-list-stats");
    revalidateTag(userDetailTag(parsed.data.userId));
  } catch (error) {
    await finishAntifraudAction({
      correlationId,
      actorAdminUserId: session.userId,
      actorRoles: roles,
      sessionRef: `${session.userId}:${session.iat ?? 0}`,
      action: `antifraud.account.${parsed.data.action}`,
      outcome: "failed",
      targetType: "user",
      targetId: parsed.data.userId,
      idempotencyKey: parsed.data.idempotencyKey,
      // Without this the security-audit row for a failed ban says nothing
      // about the identifier blocks that are already queued and will be
      // applied anyway — the one piece of state the failure left behind.
      // Key names avoid "ip"/"fingerprint": appendAntifraudSecurityAudit
      // hashes any key matching its PII pattern, which would turn the counts
      // into unreadable digests.
      metadata: {
        reasonCode: "operator_blocklist_workspace",
        identifier_blocklist_queued: identifiers !== null,
        queued_identifier_count:
          (identifiers?.ipCount ?? 0) + (identifiers?.fingerprintCount ?? 0),
        ...(identifiers
          ? { identifier_operation_id: identifiers.operationId }
          : {}),
      },
      error,
    });
    throw error;
  }
  });
}
