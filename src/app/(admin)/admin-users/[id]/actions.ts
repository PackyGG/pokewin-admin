"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { sanitizePermissionKeys } from "@/app/(admin)/settings/roles/permissions-utils";
import {
  loadUserPermissionState,
  materializeForOverride,
  getBaselineMap,
} from "@/lib/permissions/write-paths";
import { wouldReduceOwnAccessViaOverride } from "@/lib/admin-guards";

export async function forceExpireAllSessions(adminUserId: string) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_force_expire_admin_sessions", "force-expire admin sessions");

  const now = new Date();

  // Mark the admin_sessions rows logged-out (the existing behavior — keeps the
  // sessions list accurate).
  await adminDb.admin_sessions.updateMany({
    where: {
      admin_user_id: adminUserId,
      logged_out_at: null,
      expires_at: { gt: now },
    },
    data: { logged_out_at: now },
  });

  // Guard 3 — REAL revocation. The admin_sessions rows are an audit record, not
  // the auth token; the live session is the signed `admin_session` JWT in the
  // user's cookie, which the sessions list can't reach. Stamp the account's
  // `sessions_valid_after` watermark to NOW so `verifySession` (src/lib/dal.ts)
  // rejects every JWT this user already holds (issued-at before NOW) on their
  // very next request — their 12h tokens die immediately instead of lingering.
  // Wrapped so a DB without the column (shouldn't happen — it's applied on
  // prod) still completes the logged-out write + audit rather than throwing.
  try {
    await adminDb.admin_users.update({
      where: { id: adminUserId },
      data: { sessions_valid_after: now },
      select: { id: true },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const missingColumn =
      code === "P2022" ||
      (err instanceof Error && /column .* does not exist/i.test(err.message));
    if (!missingColumn) throw err;
    console.error(
      "[forceExpireAllSessions] sessions_valid_after column missing — JWT-level revocation skipped:",
      err,
    );
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_sessions_force_expired",
    metadata: { target_admin_id: adminUserId },
  });

  revalidatePath(`/admin-users/${adminUserId}`);
}

/**
 * Persist a non-admin admin user's explicit per-user override (the grant /
 * revoke layer) and re-materialize their `allowed_pages` through the ONE
 * canonical writer (`computeEffectivePermissions`).
 *
 * Phase C of the role/permission rebuild (see ROLE_REDESIGN_DESIGN.md): the
 * editor sends the operator-chosen grants/revokes; this stores them in
 * `permission_grants` / `permission_revokes` AND writes the derived
 * `allowed_pages = baseline ∪ grants \ revokes` so the runtime gate (which
 * still reads `allowed_pages`) sees the effective set. Both are written in one
 * update so the editable source and the cache never diverge.
 *
 * Guards unchanged: admin-only caller, `__can_update_admin_permissions`
 * capability, 2FA, and editing an `admin`-role target is rejected (admins
 * bypass the gate — an override would be meaningless and recording one could
 * mislead).
 */
export async function updateUserPermissions(
  userId: string,
  override: { grants: string[]; revokes: string[] },
  totpCode: string,
) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_admin_permissions", "update admin permissions");
  await require2FA(session.userId, totpCode);

  const state = await loadUserPermissionState(userId);
  if (!state) throw new Error("Admin user not found");
  if (state.roles.includes("admin")) {
    throw new Error("Cannot set permissions for admin users");
  }

  // Sanitize the supplied override against the combined page+capability
  // catalog (value-token-aware) so a stale / unknown key can't be persisted.
  const grants = sanitizePermissionKeys(override.grants ?? []);
  const revokes = sanitizePermissionKeys(override.revokes ?? []);
  const sanitizedOverride = { grants, revokes };

  // Re-materialize allowed_pages = role/custom baseline ∪ grants \ revokes
  // via the canonical materializer (the single writer for every path).
  // RoleV2 P1: thread the DB-backed built-in baseline map (byte-equal to code
  // at migration → identical output). The per-user override is unchanged.
  const baselines = await getBaselineMap();
  const allowedPages = materializeForOverride(state, sanitizedOverride, baselines);

  // Guard 2 — self-demotion. An operator can't reduce their OWN access through
  // the per-user editor. (In practice an admin can't reach here for themselves
  // — admin targets are rejected above and an admin's own role set includes
  // admin — but this is defense-in-depth: any self-edit that removes a token
  // the actor currently holds is blocked.) `state.allowedPages` is the actor's
  // current materialized set; `allowedPages` is the post-save set.
  if (
    wouldReduceOwnAccessViaOverride({
      isSelf: session.userId === userId,
      currentAllowed: state.allowedPages,
      nextAllowed: allowedPages,
    })
  ) {
    throw new Error("You can't remove your own admin access");
  }

  await adminDb.admin_users.update({
    where: { id: userId },
    data: {
      permission_grants: grants,
      permission_revokes: revokes,
      allowed_pages: allowedPages,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_permissions_updated",
    metadata: {
      target_admin_id: userId,
      grants,
      revokes,
      allowed_pages: allowedPages,
    },
  });

  revalidatePath(`/admin-users/${userId}`);
  revalidatePath("/", "layout");
}

export async function searchMainSiteUsers(query: string) {
  const db = await getDb();
  await requireAdmin();

  if (!query || query.length < 2) return [];

  const users = await db.user.findMany({
    where: {
      OR: [
        { username: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
      ],
    },
    select: { id: true, username: true, email: true, role: true },
    take: 10,
  });

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
  }));
}

export async function linkCreatorToMainUser(adminUserId: string, mainUserId: string) {
  const db = await getDb();
  const session = await requireAdmin();

  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { role: true, email: true },
  });
  if (!adminUser || adminUser.role !== "creator") {
    throw new Error("Admin user is not a creator");
  }

  const mainUser = await db.user.findUnique({
    where: { id: mainUserId },
    select: { id: true, email: true, username: true, role: true },
  });
  if (!mainUser) throw new Error("Main site user not found");
  if (!mainUser.email) throw new Error("Main site user has no email");

  // Update admin_user email to match main site user (this is how linking works)
  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: { email: mainUser.email },
    select: { id: true },
  });

  // If the main user isn't already a creator, set them up
  if (mainUser.role !== "creator") {
    const code = (mainUser.username ?? mainUser.email.split("@")[0])
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

    let finalCode = code;
    const existingCode = await db.affiliate_codes.findUnique({ where: { code: finalCode } });
    if (existingCode) {
      finalCode = `${code}${Math.floor(Math.random() * 1000)}`;
    }

    await db.$transaction([
      db.user.update({
        where: { id: mainUserId },
        data: { role: "creator", affiliate_code: finalCode, affiliate_code_active: true },
      }),
      db.affiliate_accounts.create({
        data: { user_id: mainUserId },
      }),
      db.affiliate_codes.create({
        data: { user_id: mainUserId, code: finalCode },
      }),
    ]);
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_linked_to_main_user",
    metadata: {
      target_admin_id: adminUserId,
      main_user_id: mainUserId,
      main_user_email: mainUser.email,
    },
  });

  revalidatePath(`/admin-users/${adminUserId}`);
}
