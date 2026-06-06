"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { admin_role } from "@/generated/admin-prisma/client";
import { require2FA } from "@/lib/require-2fa";
import { ok, fail, type ServerActionResult } from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";
import { computeAllowedPagesForRoles } from "@/lib/role-baselines";
import { isPersistableAdminRole, pickPrimaryRole } from "@/lib/admin-roles";
import { writeAdminUserWithRoles } from "@/lib/admin-user-roles";

/**
 * Normalize a caller-supplied role payload into a deduped, validated set
 * of built-in roles. Accepts either the legacy single `role` string or
 * the new `roles` array (or both — they're merged). Drops unknown values.
 * Returns null when nothing valid was supplied so callers can reject.
 */
function normalizeRoles(input: {
  role?: string;
  roles?: string[];
}): admin_role[] | null {
  const set = new Set<admin_role>();
  for (const r of [...(input.roles ?? []), ...(input.role ? [input.role] : [])]) {
    // Only PERSISTABLE built-in roles (those present in the admin-DB
    // `admin_role` enum) may be stored. `isPersistableAdminRole` narrows to
    // the exact Prisma-enum subset, so the code-only `creator_manager` is
    // dropped here — it can't be written to the DB until the enum carries
    // it (see PERSISTABLE_ADMIN_ROLES in src/lib/admin-roles.ts).
    if (isPersistableAdminRole(r)) set.add(r);
  }
  return set.size > 0 ? [...set] : null;
}

/**
 * Create a new admin user with role-inherited allowed_pages. Accepts one
 * OR several system roles (`roles`); the legacy single `role` field is
 * still accepted for backward-compat. The new user's allowed_pages is the
 * UNION of every assigned role's preset. Returns ServerActionResult —
 * callers must check `result.success`. Permission + validation failures
 * surface a specific message; unexpected DB crashes return a generic
 * "couldn't create" message and log to Vercel.
 */
export async function createAdminUser(data: {
  email: string;
  username: string;
  password: string;
  role?: string;
  roles?: string[];
}): Promise<ServerActionResult<{ id: string }>> {
  const session = await requireAdmin();
  try {
    await requireCapability(
      session,
      "__can_create_admin_user",
      "create admin users",
    );
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

  const roles = normalizeRoles(data);
  if (!roles) {
    return fail("Pick at least one valid role.", "VALIDATION");
  }
  // The canonical primary role (highest-privilege member, admin first).
  // `roles` is already narrowed to the persistable `admin_role` subset by
  // `normalizeRoles`, and `pickPrimaryRole` returns a member of its input,
  // so the result is a real `admin_role` — narrow it back for Prisma.
  const primary = pickPrimaryRole(roles) as admin_role;

  const passwordHash = await bcrypt.hash(data.password, 12);

  // Seed allowed_pages as the UNION of every assigned role's preset (each
  // copied off an existing user of that role, else the role's fixed
  // baseline). admin among the roles → [] (admin bypasses the page list).
  const allowedPages = await computeAllowedPagesForRoles(roles);

  // Explicit select — Prisma's default create() RETURNS * which references
  // every column the generated client knows about. If a new column is
  // missing from prod (preferences / role_id / profile_*), the insert
  // crashes with P2022 even though the write itself would succeed.
  let created: { id: string };
  try {
    // Resilient to the un-applied `roles` migration: if the additive
    // `roles` column doesn't exist yet, retry the create without it so the
    // canonical `role` + `allowed_pages` still persist (effective role set
    // collapses to `[role]` — identical to legacy single-role behaviour).
    created = await writeAdminUserWithRoles(
      () =>
        adminDb.admin_users.create({
          data: {
            email: data.email,
            username: data.username,
            password_hash: passwordHash,
            // `role` stays the canonical primary; `roles` holds the full set.
            role: primary,
            roles,
            allowed_pages: allowedPages,
          },
          select: { id: true },
        }),
      () =>
        adminDb.admin_users.create({
          data: {
            email: data.email,
            username: data.username,
            password_hash: passwordHash,
            role: primary,
            allowed_pages: allowedPages,
          },
          select: { id: true },
        }),
    );
  } catch (err) {
    // Most common path: P2002 unique-violation on email / username.
    // Surface a friendly message; the raw Prisma error goes to logs.
    logError(
      "admin-users.create",
      `failed to create admin user ${data.email}`,
      err,
    );
    if (err instanceof Error && /unique constraint|already exists/i.test(err.message)) {
      return fail(
        "An admin with that email or username already exists.",
        "DUPLICATE",
      );
    }
    return fail(
      "Couldn't create the admin user — check the inputs and try again.",
    );
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_user_created",
    metadata: { email: data.email, username: data.username, roles },
  });

  revalidatePath("/admin-users");
  return ok({ id: created.id });
}

export async function toggleAdminActive(
  adminUserId: string,
  isActive: boolean,
  totpCode: string,
) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_toggle_admin_active", "activate / deactivate admins");

  // Self-protection: deactivating yourself locks you out instantly. Mirror
  // the check already in `deleteAdminUser` so the same accident can't be
  // made on the toggle path.
  if (adminUserId === session.userId && !isActive) {
    throw new Error("You cannot deactivate yourself");
  }

  await require2FA(session.userId, totpCode);

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: { is_active: isActive },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: isActive ? "admin_user_activated" : "admin_user_deactivated",
    metadata: { target_admin_id: adminUserId },
  });

  revalidatePath("/admin-users");
}

export async function resetAdmin2FA(adminUserId: string, totpCode: string) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_reset_admin_2fa", "reset admin 2FA");
  await require2FA(session.userId, totpCode);

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: {
      totp_secret: null,
      totp_enabled: false,
      recovery_codes: [],
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_2fa_reset",
    metadata: { target_admin_id: adminUserId },
  });

  revalidatePath("/admin-users");
}

/**
 * Set the FULL system-role set for an admin user (multi-role). Replaces
 * the user's `roles` with the supplied set and keeps the singular `role`
 * column in sync as the highest-privilege primary. Gated on
 * __can_change_admin_role + 2FA, exactly like the old single-role path.
 *
 * Permission handling is ADDITIVE: the baselines (page + capability keys)
 * of every role in the new set are unioned ONTO the user's current
 * allowed_pages. Existing per-user grants are never stripped — switching
 * or adding a role only ever grants access, never silently revokes the
 * manual adjustments an admin made. (To truly restrict a user, edit their
 * permissions in the per-user editor below the role card.) If `admin` is
 * among the new roles, allowed_pages is irrelevant — admin bypasses every
 * page/capability gate.
 *
 * Note: every built-in role is accepted, INCLUDING `pack_creator`. The
 * previous single-role `changeAdminRole` validated against a hardcoded
 * ["admin","support","marketing","creator"] list that OMITTED
 * pack_creator, so assigning pack_creator threw "Invalid admin role" and
 * surfaced as a server error — that gap is closed here.
 */
export async function setAdminRoles(
  adminUserId: string,
  newRoles: string[],
  totpCode: string,
) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_change_admin_role", "change admin roles");

  await require2FA(session.userId, totpCode);

  const roles = normalizeRoles({ roles: newRoles });
  if (!roles) {
    throw new Error("Pick at least one valid role");
  }
  // `roles` is the persistable `admin_role` subset (normalizeRoles); the
  // primary is one of those members, so narrow it back for the Prisma write.
  const primary = pickPrimaryRole(roles) as admin_role;

  const target = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { allowed_pages: true },
  });
  if (!target) throw new Error("Admin user not found");

  // Additive merge: current grants ∪ every new role's baseline. Never
  // removes a manually-granted key. admin → empty list (bypass).
  const baseline = await computeAllowedPagesForRoles(roles);
  const mergedAllowed = roles.includes("admin")
    ? []
    : [...new Set([...target.allowed_pages, ...baseline])];

  // Resilient to the un-applied `roles` migration: if the additive `roles`
  // column doesn't exist yet, retry the update without it. The canonical
  // `role` (primary) and the additively-merged `allowed_pages` still
  // persist, so the role change takes effect; the effective set collapses
  // to `[role]` until the migration is applied — identical to the legacy
  // single-role path, and never wipes the merged grants.
  await writeAdminUserWithRoles(
    () =>
      adminDb.admin_users.update({
        where: { id: adminUserId },
        data: { role: primary, roles, allowed_pages: mergedAllowed },
        select: { id: true },
      }),
    () =>
      adminDb.admin_users.update({
        where: { id: adminUserId },
        data: { role: primary, allowed_pages: mergedAllowed },
        select: { id: true },
      }),
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_role_changed",
    metadata: { target_admin_id: adminUserId, new_roles: roles },
  });

  revalidatePath("/admin-users");
  revalidatePath(`/admin-users/${adminUserId}`);
  revalidatePath("/", "layout");
}

/**
 * Backward-compatible single-role setter — kept so any caller still
 * passing one role keeps working. Delegates to setAdminRoles with a
 * one-element set.
 */
export async function changeAdminRole(adminUserId: string, newRole: string, totpCode: string) {
  return setAdminRoles(adminUserId, [newRole], totpCode);
}

export async function deleteAdminUser(
  adminUserId: string,
  totpCode: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_admin_user", "delete admin users");

  // Can't delete yourself
  if (adminUserId === session.userId) {
    return { success: false, error: "You cannot delete your own account" };
  }

  // 2FA gate AFTER the self-deletion guard so the user-facing "you cannot
  // delete yourself" error doesn't depend on TOTP being valid first.
  // require2FA throws on invalid; the caller surfaces it via toast.
  await require2FA(session.userId, totpCode);

  const target = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { id: true, email: true, username: true },
  });
  if (!target) return { success: false, error: "Admin user not found" };

  // Audit BEFORE the delete so the event is always on record
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_user_deleted",
    metadata: { target_admin_id: adminUserId, email: target.email, username: target.username },
  });

  try {
    await adminDb.$transaction(async (tx) => {
      // Null out admin_user_id on audit events (keep the logs)
      await tx.admin_audit_events.updateMany({
        where: { admin_user_id: adminUserId },
        data: { admin_user_id: null },
      });

      // Delete all related records with required FKs
      await tx.admin_sessions.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.admin_notes.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.admin_gift_card_actions.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.admin_voucher_actions.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.expenses.deleteMany({ where: { created_by_id: adminUserId } });
      await tx.recurring_expenses.deleteMany({ where: { created_by_id: adminUserId } });

      // Delete the admin user
      await tx.admin_users.delete({ where: { id: adminUserId } });
    });
  } catch (err) {
    console.error("[deleteAdminUser] Transaction failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Delete failed: ${message}` };
  }

  revalidatePath("/admin-users");
  return { success: true };
}
