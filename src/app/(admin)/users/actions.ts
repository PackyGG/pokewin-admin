"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { resolveAdminMainUserId } from "@/lib/resolve-admin-main-user-id";
import { getDistinctUserCountries } from "@/lib/queries/users-export";
import { requireUsersExportAdmin } from "@/lib/users-export/motha-gate";
import {
  getAllUsersForExport,
  allUsersToCsv,
} from "@/lib/users-export/all-users-csv";
import {
  buildUserSnapshot,
  snapshotToJsonValue,
} from "@/lib/deleted-users/snapshot";
import type { Prisma as AdminPrisma } from "@/generated/admin-prisma/client";
import { ok, fail, type ServerActionResult } from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";

// 7-day soft-delete window for admin_deleted_users snapshots. Mirrored
// in /users/deleted's purge-on-read scan and the restore action's
// expiry check.
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Lazily-fetched list of distinct user countries. Used by the Export
 * dialog's country filter. The query was previously eager-fetched on
 * every /users page render even though the dialog is opened rarely —
 * this server action lets the dialog defer the lookup until it's
 * actually opened. Page-level cost goes from ~1 wide-table scan per
 * render to zero for the common path of admins listing users without
 * exporting.
 */
export async function fetchDistinctUserCountries() {
  await requirePageAccess("/users");
  return getDistinctUserCountries();
}

/**
 * Ban a user account. Atomically: flip is_banned + capture reason +
 * tombstone every active session so they're kicked out instantly.
 * Returns ServerActionResult — callers check `result.success`.
 */
export async function banUser(
  userId: string,
  reason: string,
): Promise<ServerActionResult<{ userId: string }>> {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  try {
    await requireCapability(session, "__can_ban_users", "ban users");
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

  if (!reason || !reason.trim()) {
    return fail("Ban reason is required.", "VALIDATION");
  }

  // `user.banned_by` is a nullable FK to Main-DB `User.id`. Admin
  // identities live in the Admin DB so we resolve via email match;
  // unlinked admins fall back to null and the audit event below
  // remains the source of truth for who actually triggered the ban.
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);

  try {
    await db.$transaction([
      db.user.update({
        where: { id: userId },
        data: {
          is_banned: true,
          banned_reason: reason,
          banned_at: new Date(),
          banned_by: issuerMainUserId,
        },
      }),
      db.session.deleteMany({ where: { userId } }),
    ]);
  } catch (err) {
    logError("users.ban", `ban transaction failed for ${userId}`, err);
    // Prisma P2025 = record not found (user already deleted).
    if (err instanceof Error && /No record was found/i.test(err.message)) {
      return fail("User not found.", "NOT_FOUND");
    }
    return fail("Couldn't ban this user — please try again.");
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_banned",
    targetUserId: userId,
    metadata: { reason, issuer_main_user_id: issuerMainUserId },
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
  revalidatePath("/chat");
  return ok({ userId });
}

export async function unbanUser(userId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_ban_users", "unban users");

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        is_banned: false,
        banned_reason: null,
        banned_at: null,
        banned_by: null,
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_unbanned",
    targetUserId: userId,
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
}

/**
 * Lock a user account (softer than ban — they can still log in but
 * gambling / withdraw paths are gated). Returns ServerActionResult.
 */
export async function lockUser(
  userId: string,
  reason: string,
): Promise<ServerActionResult<{ userId: string }>> {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  try {
    await requireCapability(session, "__can_lock_users", "lock user accounts");
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

  if (!reason || !reason.trim()) {
    return fail("Lock reason is required.", "VALIDATION");
  }

  // `user.locked_by` is a nullable FK to Main-DB `User.id`. Same
  // resolution as `banUser` — admin → main user via email; null when
  // no match. Audit event is the canonical trail.
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);

  try {
    await db.$transaction([
      db.user.update({
        where: { id: userId },
        data: {
          is_locked: true,
          locked_reason: reason,
          locked_at: new Date(),
          locked_by: issuerMainUserId,
        },
      }),
    ]);
  } catch (err) {
    logError("users.lock", `lock transaction failed for ${userId}`, err);
    if (err instanceof Error && /No record was found/i.test(err.message)) {
      return fail("User not found.", "NOT_FOUND");
    }
    return fail("Couldn't lock this user — please try again.");
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_locked",
    targetUserId: userId,
    metadata: { reason, issuer_main_user_id: issuerMainUserId },
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
  return ok({ userId });
}

export async function unlockUser(userId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_lock_users", "unlock user accounts");

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        is_locked: false,
        locked_reason: null,
        locked_at: null,
        locked_by: null,
        locked_until: null,
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_unlocked",
    targetUserId: userId,
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
}

/**
 * motha-ONLY "export all users" CSV. Distinct from the capability-gated
 * `/api/users/export` dialog (rich filters, any admin): this is a
 * one-click raw dump of EVERY user as exactly three columns — email,
 * username, deposit amount — restricted to the single `motha` admin.
 *
 * `requireUsersExportAdmin()` is the real gate: it re-reads the live
 * username from the DB and THROWS for anyone who isn't motha, so a
 * non-motha admin/support/marketing/creator gets the error, never the
 * data. Hiding the button client-side is defense-in-depth only.
 *
 * Returns the CSV string + a filename for the client to Blob + download
 * (the house "action returns string → client triggers download"
 * pattern). Audited via `users_all_export` with the ROW COUNT ONLY —
 * never the emails/amounts themselves (no row PII in the audit log,
 * per CLAUDE.md).
 */
export async function exportAllUsersCsv(): Promise<{
  csv: string;
  filename: string;
}> {
  const session = await requireUsersExportAdmin();

  const rows = await getAllUsersForExport();
  const csv = allUsersToCsv(rows);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "users_all_export",
    metadata: { rows: rows.length },
  });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return { csv, filename: `all-users-${ts}.csv` };
}

export async function bulkDeleteUsers(userIds: string[], totpCode: string) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_bulk_delete_users", "bulk-delete users");
  await require2FA(session.userId, totpCode);

  if (userIds.length === 0) throw new Error("No users selected");
  if (userIds.length > 100) throw new Error("Max 100 users at once");

  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true, email: true },
  });

  const labels = new Map(
    users.map((u) => [u.id, u.username ?? u.email ?? u.id]),
  );
  const emails = new Map(users.map((u) => [u.id, u.email ?? null]));
  const usernames = new Map(users.map((u) => [u.id, u.username ?? null]));

  // Build snapshots in parallel — each user's reads are independent.
  // If any snapshot build throws we abort the whole bulk delete; no
  // main-DB writes have happened yet so this is safe.
  const snapshots = await Promise.all(
    userIds.map((id) => buildUserSnapshot(db, id)),
  );

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SNAPSHOT_RETENTION_MS);

  // Upsert all snapshots before touching the main DB. We use Promise.all
  // over individual upserts (not createMany) because JSONB + upsert
  // semantics + restored_at-clear-on-overwrite need per-row handling.
  // If the admin DB blows up here, the main DB hasn't been touched yet.
  await Promise.all(
    userIds.map((id, idx) => {
      const snapshotJson = snapshotToJsonValue(
        snapshots[idx],
      ) as AdminPrisma.InputJsonValue;
      return adminDb.admin_deleted_users.upsert({
        where: { id },
        create: {
          id,
          username: usernames.get(id) ?? null,
          email: emails.get(id) ?? null,
          deleted_at: now,
          deleted_by: session.userId,
          expires_at: expiresAt,
          snapshot: snapshotJson,
        },
        update: {
          username: usernames.get(id) ?? null,
          email: emails.get(id) ?? null,
          deleted_at: now,
          deleted_by: session.userId,
          expires_at: expiresAt,
          snapshot: snapshotJson,
          restored_at: null,
          restored_by: null,
        },
      });
    }),
  );

  // Audit AFTER the snapshots land so the audit row references the
  // backups that actually exist.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "users_bulk_deleted",
    metadata: {
      count: userIds.length,
      users: userIds.map((id, idx) => ({
        id,
        username: labels.get(id) ?? id,
        truncated: snapshots[idx]._truncated,
      })),
      snapshot_expires_at: expiresAt.toISOString(),
    },
  });

  // Destructive delete. On failure we roll back the snapshots we just
  // inserted — best-effort so /users/deleted doesn't fill with ghosts.
  try {
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } catch (err) {
    await adminDb.admin_deleted_users
      .deleteMany({ where: { id: { in: userIds } } })
      .catch(() => {
        console.error(
          `[bulkDeleteUsers] failed to roll back ${userIds.length} snapshots after main-DB deleteMany failure`,
        );
      });
    throw err;
  }

  revalidatePath("/users");
  revalidatePath("/users/deleted");
}
