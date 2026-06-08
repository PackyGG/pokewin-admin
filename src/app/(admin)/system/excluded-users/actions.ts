"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requireExcludedUsersAccess } from "@/lib/excluded-users/gate";
import { refreshExcludedUserIdsCache } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";

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

  await refreshExcludedUserIdsCache();
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

  if (result.count > 0) {
    await refreshExcludedUserIdsCache();
  }
  revalidatePath("/system/excluded-users");
  return { ok: true, deleted: result.count };
}

// ───────────────────────────────────────────────────────────────────
// Balance 2.0 (admin-managed per-excluded-user editable value)
// ───────────────────────────────────────────────────────────────────
//
// Stored in admin_excluded_user_balance_v2 (admin DB). Mirrors the
// shape + formatting of the Total Deposited column on the page but is
// editable per user. The table is provisioned by the
// 20260605000000_add_excluded_user_balance_v2 migration — until that
// migration is applied the action returns a clean error rather than
// blowing up with a Prisma P2021 ("table does not exist").

// Postgres "undefined_table" SQLSTATE — same helper logic as fetch.ts.
// Inlined here to avoid pulling a UI/server-only utility across the
// "use server" boundary.
function isTableMissingError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; meta?: { code?: unknown } };
  return (
    e.code === "P2021" ||
    e.code === "P2010" ||
    e.meta?.code === "42P01"
  );
}

const setBalanceV2Schema = z.object({
  // Reuse the same shape validation as addExcludedUser — the target id
  // is the packy.gg user_id, not an arbitrary string.
  userId: z
    .string()
    .trim()
    .min(8, "User ID looks too short")
    .max(64, "User ID looks too long")
    .regex(USER_ID_REGEX, "User ID contains invalid characters"),
  // Decimal coercion: clients send the value as a string (matches the
  // input element) — Zod converts to number, then we validate range +
  // precision. Decimal(20,2) accepts up to 18 integer digits but a
  // single Balance 2.0 entry will never realistically need more than
  // a few million; cap at 9_999_999_999.99 like admin_balance_limits.
  balanceV2: z
    .union([z.number(), z.string()])
    .transform((v, ctx) => {
      const n = typeof v === "string" ? Number(v) : v;
      if (!Number.isFinite(n)) {
        ctx.addIssue({
          code: "custom",
          message: "Balance 2.0 must be a number",
        });
        return z.NEVER;
      }
      return n;
    })
    .refine((n) => n >= 0, "Balance 2.0 must be zero or positive")
    .refine((n) => n <= 9_999_999_999.99, "Balance 2.0 is too large")
    // Two-decimal-place check by writing through Decimal(20,2) anyway —
    // we round to cents server-side rather than rejecting fractional
    // pennies, since the column would truncate them silently otherwise.
    .transform((n) => Math.round(n * 100) / 100),
  notes: z
    .string()
    .trim()
    .max(500, "Notes are too long")
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

/**
 * Set the editable Balance 2.0 value for an excluded user. Upserts on
 * target_user_id so a single user only ever has one row. Motha-only
 * gate (reuses requireExcludedUsersAccess). Audit event includes the
 * prev + new value so the audit trail can show diffs.
 *
 * Returns a structured result (HTTP 200) on validation failure so the
 * client can render the real message via toast.error. Genuine DB
 * failures throw so the error boundary / logs see them.
 *
 * Pre-migration: returns a clean { ok: false, error } pointing at the
 * migration the owner needs to apply, instead of a generic 500.
 */
export async function setExcludedUserBalanceV2(input: {
  userId: string;
  balanceV2: number | string;
  notes?: string | null;
}): Promise<ActionResult<{ balanceV2: number }>> {
  const session = await requireExcludedUsersAccess();
  const parsed = setBalanceV2Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { userId, balanceV2, notes } = parsed.data;

  // Verify the target is actually excluded — Balance 2.0 is per-
  // excluded-user, not a general per-user annotation. This also catches
  // a stale UI where someone removed the user in another tab before
  // the save click landed.
  const exists = await adminDb.excluded_users.findUnique({
    where: { user_id: userId },
    select: { user_id: true },
  });
  if (!exists) {
    return { ok: false, error: "User is not on the blacklist" };
  }

  try {
    // Read prev value so the audit row carries the diff. Treat
    // table-missing the same as no row.
    let prevValue: number | null = null;
    try {
      const prev = await adminDb.admin_excluded_user_balance_v2.findUnique({
        where: { target_user_id: userId },
        select: { balance_v2: true },
      });
      prevValue = prev ? toNumber(prev.balance_v2) : null;
    } catch (e) {
      if (!isTableMissingError(e)) throw e;
      // Table missing — let the write below surface the same error
      // so we report it once with a clean message.
    }

    await adminDb.admin_excluded_user_balance_v2.upsert({
      where: { target_user_id: userId },
      create: {
        target_user_id: userId,
        balance_v2: balanceV2,
        set_by_admin_id: session.userId,
        notes,
      },
      update: {
        balance_v2: balanceV2,
        set_by_admin_id: session.userId,
        set_at: new Date(),
        notes,
      },
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "excluded_user_balance_v2_set",
      targetUserId: userId,
      metadata: {
        target_user_id: userId,
        prev_value: prevValue,
        new_value: balanceV2,
        notes,
      },
    });

    revalidatePath("/system/excluded-users");
    return { ok: true, balanceV2 };
  } catch (err) {
    if (isTableMissingError(err)) {
      return {
        ok: false,
        error:
          "Balance 2.0 table is missing — apply the migration at prisma/admin/migrations/20260605000000_add_excluded_user_balance_v2/migration.sql, then try again.",
      };
    }
    throw err;
  }
}
