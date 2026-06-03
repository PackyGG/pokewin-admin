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
  // `.nullish()` accepts both `undefined` (no reason typed) AND `null` (an
  // explicit null payload) — a bare `.optional()` rejects `null` with a Zod
  // "expected string, received null", which previously surfaced as a 500.
  reason: z
    .string()
    .trim()
    .max(500, "Reason is too long")
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

/**
 * Result shape shared by both mutations. A discriminated union so the
 * client can branch on `ok`: success carries the operation payload, a
 * failure carries a human-readable `error` for a sonner toast.
 *
 * WHY a returned result instead of `throw` (the bug this fixes): a
 * Server Action that THROWS a plain Error is turned by Next.js into an
 * HTTP 500 for the action POST, and in production the message is redacted
 * to an opaque digest. The owner hit exactly this — submitting an invalid
 * / too-short / duplicate-with-null-reason ID made the action throw, so
 * the page POST 500'd with only a generic toast. Returning a structured
 * result keeps the POST a clean 200 and lets the client render the real
 * validation message. Genuine infrastructure failures (DB down, etc.) are
 * deliberately NOT caught here — those still throw so they aren't silently
 * swallowed and the /system error boundary / logs still see them.
 */
type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Add a packy.gg user_id to the blacklist. Motha-only gate.
 *
 * Idempotent on user_id (primary key) — re-adding an existing entry
 * is a no-op (`inserted: 0`) so a double-click on the form doesn't
 * create a duplicate. The audit row only fires when a new row was
 * actually inserted. Validation failures return `{ ok: false, error }`
 * (HTTP 200) instead of throwing (which would 500 the POST).
 */
export async function addExcludedUser(input: {
  userId: string;
  reason?: string | null;
}): Promise<ActionResult<{ inserted: 0 | 1 }>> {
  const session = await requireExcludedUsersAccess();
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { userId, reason } = parsed.data;

  const existing = await adminDb.excluded_users.findUnique({
    where: { user_id: userId },
    select: { user_id: true },
  });
  if (existing) {
    return { ok: true, inserted: 0 };
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
  return { ok: true, inserted: 1 };
}

/**
 * Remove a user_id from the blacklist. Motha-only gate. Uses
 * `deleteMany` so a stale double-click after another tab already
 * removed the row is a no-op rather than a P2025 throw. A missing /
 * empty id returns `{ ok: false, error }` (HTTP 200) instead of
 * throwing (which would 500 the POST).
 */
export async function removeExcludedUser(
  userId: string,
): Promise<ActionResult<{ deleted: number }>> {
  const session = await requireExcludedUsersAccess();
  if (typeof userId !== "string" || userId.trim().length === 0) {
    return { ok: false, error: "Missing user ID" };
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
  return { ok: true, deleted: result.count };
}
