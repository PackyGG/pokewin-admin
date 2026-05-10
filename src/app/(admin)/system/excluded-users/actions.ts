"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requireExcludedUsersAccess } from "@/lib/excluded-users/gate";

// packy.gg user_ids are 32-char alphanumeric strings (better-auth
// nanoid-style). Validate strictly so a typo or paste of "https://…/users/<id>"
// doesn't insert garbage into the blacklist table.
const USER_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const addSchema = z.object({
  userId: z
    .string()
    .trim()
    .min(8, "User ID looks too short")
    .max(64, "User ID looks too long")
    .regex(USER_ID_REGEX, "User ID contains invalid characters"),
  reason: z
    .string()
    .trim()
    .max(500, "Reason is too long")
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

/**
 * Add a packy.gg user_id to the blacklist. Motha-only gate.
 *
 * Idempotent on user_id (primary key) — re-adding an existing entry
 * is a no-op so a double-click on the form doesn't 500. The audit
 * row only fires when a new row was actually inserted.
 */
export async function addExcludedUser(input: {
  userId: string;
  reason?: string;
}) {
  const session = await requireExcludedUsersAccess();
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { userId, reason } = parsed.data;

  const existing = await adminDb.excluded_users.findUnique({
    where: { user_id: userId },
    select: { user_id: true },
  });
  if (existing) {
    return { inserted: 0 };
  }

  await adminDb.excluded_users.create({
    data: {
      user_id: userId,
      reason,
      excluded_by: session.userId,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "excluded_user_added",
    targetUserId: userId,
    metadata: { reason },
  });

  revalidatePath("/system/excluded-users");
  return { inserted: 1 };
}

/**
 * Remove a user_id from the blacklist. Motha-only gate. Uses
 * `deleteMany` so a stale double-click after another tab already
 * removed the row is a no-op rather than a P2025 throw.
 */
export async function removeExcludedUser(userId: string) {
  const session = await requireExcludedUsersAccess();
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("Missing user_id");
  }

  const result = await adminDb.excluded_users.deleteMany({
    where: { user_id: userId },
  });

  if (result.count > 0) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "excluded_user_removed",
      targetUserId: userId,
    });
  }

  revalidatePath("/system/excluded-users");
  return { deleted: result.count };
}
