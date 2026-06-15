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
import { readAdminUserWithRoles, writeAdminUserWithRoles } from "@/lib/admin-user-roles";
import {
  loadUserPermissionState,
  rematerializeForRoleChange,
  getBaselineMap,
} from "@/lib/permissions/write-paths";
import {
  countOtherActiveEffectiveAdmins,
  roleSetHasAdmin,
  wouldDropLastActiveAdmin,
  wouldRemoveOwnAdminViaRoles,
} from "@/lib/admin-guards";

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
    // Only PERSISTABLE built-in roles (admin-DB `admin_role` enum values).
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

  // Guard 1 — last-admin. Deactivating an admin removes them from the active-
  // admin pool. Block it when the target is an admin being turned OFF and no
  // OTHER active admin remains. Reads the target's effective roles resiliently
  // (the additive `roles` column degrades to [] → effective [role]). The
  // self-deactivation case is already blocked above; this covers deactivating
  // the last OTHER admin.
  if (!isActive) {
    const target = await readAdminUserWithRoles(
      () =>
        adminDb.admin_users.findUnique({
          where: { id: adminUserId },
          select: { role: true, roles: true },
        }),
      () =>
        adminDb.admin_users.findUnique({
          where: { id: adminUserId },
          select: { role: true },
        }),
    );
    if (target) {
      const t = target as { role: string; roles?: string[] };
      const targetIsAdmin = roleSetHasAdmin(t.role, t.roles);
      if (targetIsAdmin) {
        const otherActiveAdmins = await countOtherActiveEffectiveAdmins(adminUserId);
        if (
          wouldDropLastActiveAdmin({
            // The target IS an active admin today (this action is flipping it
            // OFF) — guaranteed active here because we only reach this when the
            // toggle target is being deactivated from an active state.
            targetIsActiveAdminNow: true,
            targetStaysActiveAdmin: false,
            otherActiveAdminCount: otherActiveAdmins,
          })
        ) {
          throw new Error("Cannot remove the last active admin");
        }
      }
    }
  }

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
 * Permission handling (Phase C): `allowed_pages` is RE-MATERIALIZED through
 * the canonical materializer (computeEffectivePermissions) as
 * `newRolesBaseline ∪ grants \ revokes`. The user's per-user override is
 * PRESERVED — their explicit grants/revokes if set, otherwise the override
 * derived from the gap between their current allowed_pages and their OLD
 * baseline, so every MANUAL adjustment survives the role switch. Tokens that
 * came only from a role being REMOVED (and were never manually kept) follow
 * the new baseline rather than lingering — this is the intended canonical
 * behavior (to keep such a token, add it as an explicit grant in the per-user
 * editor). If `admin` is among the new roles, allowed_pages is `[]` — admin
 * bypasses every page/capability gate.
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

  // Load the full permission state (role/roles + custom-role tokens + the
  // per-user override columns + current allowed_pages).
  const state = await loadUserPermissionState(adminUserId);
  if (!state) throw new Error("Admin user not found");

  // ── Phase D guards ──────────────────────────────────────────────────────────
  // Whether the target holds the effective `admin` role today vs. under the
  // proposed role set. `state.roles` is the current effective set;
  // `roles`/`primary` are the new persistable set.
  const targetIsAdminNow = state.roles.includes("admin");
  const targetStaysAdmin = roleSetHasAdmin(primary, roles);

  // Guard 2 — self-demotion. An admin can't strip their OWN admin role.
  if (
    wouldRemoveOwnAdminViaRoles({
      isSelf: session.userId === adminUserId,
      currentlyAdmin: targetIsAdminNow,
      newRoles: roles,
    })
  ) {
    throw new Error("You can't remove your own admin access");
  }

  // Guard 1 — last-admin. Block a role change that would drop the count of
  // ACTIVE admins to zero. Only relevant when this change removes the target's
  // admin role; `targetStaysAdmin` short-circuits the (cheap) DB count when it
  // doesn't. We require the TARGET to be active today for it to "count" as the
  // last admin — a deactivated admin isn't holding an active admin slot.
  if (targetIsAdminNow && !targetStaysAdmin) {
    const targetRow = await adminDb.admin_users.findUnique({
      where: { id: adminUserId },
      select: { is_active: true },
    });
    const otherActiveAdmins = await countOtherActiveEffectiveAdmins(adminUserId);
    if (
      wouldDropLastActiveAdmin({
        targetIsActiveAdminNow: targetRow?.is_active === true,
        targetStaysActiveAdmin: false,
        otherActiveAdminCount: otherActiveAdmins,
      })
    ) {
      throw new Error("Cannot remove the last active admin");
    }
  }

  // Canonical re-materialization (Phase C): route through the ONE materializer
  // (computeEffectivePermissions) instead of the old additive `current ∪
  // baseline` merge. The user's per-user override is PRESERVED — explicit
  // grants/revokes if they exist, otherwise the override derived from the gap
  // between their stored allowed_pages and their OLD baseline (so the manual
  // adjustments they made survive the role switch). The new roles' baseline +
  // their existing custom-role tokens form the new baseline. admin among the
  // new roles → materializer returns [] (gate bypass). The persisted override
  // columns are unchanged here (a role change never edits the per-user layer).
  // `rematerializeForRoleChange` normalizes the role list via getEffectiveRoles.
  // RoleV2 P1: thread the DB-backed built-in baseline map (byte-equal to code
  // at migration → identical output; both the derived override AND the new
  // materialization use it consistently).
  const baselines = await getBaselineMap();
  const { allowedPages: mergedAllowed } = rematerializeForRoleChange(
    state,
    roles,
    state.customRoleTokens,
    baselines,
  );

  // Resilient to the un-applied `roles` migration: if the additive `roles`
  // column doesn't exist yet, retry the update without it. The canonical
  // `role` (primary) and the re-materialized `allowed_pages` still persist,
  // so the role change takes effect; the effective set collapses to `[role]`
  // until the migration is applied — identical to the legacy single-role path.
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

  const target = await readAdminUserWithRoles(
    () =>
      adminDb.admin_users.findUnique({
        where: { id: adminUserId },
        select: { id: true, email: true, username: true, role: true, roles: true, is_active: true },
      }),
    () =>
      adminDb.admin_users.findUnique({
        where: { id: adminUserId },
        select: { id: true, email: true, username: true, role: true, is_active: true },
      }),
  );
  if (!target) return { success: false, error: "Admin user not found" };

  // Guard 1 — last-admin. Deleting an active admin removes them from the pool.
  // Block when the target is an active admin and no OTHER active admin remains.
  {
    const t = target as {
      role: string;
      roles?: string[];
      is_active: boolean;
    };
    if (t.is_active && roleSetHasAdmin(t.role, t.roles)) {
      const otherActiveAdmins = await countOtherActiveEffectiveAdmins(adminUserId);
      if (
        wouldDropLastActiveAdmin({
          targetIsActiveAdminNow: true,
          targetStaysActiveAdmin: false,
          otherActiveAdminCount: otherActiveAdmins,
        })
      ) {
        return { success: false, error: "Cannot remove the last active admin" };
      }
    }
  }

  // Audit BEFORE the delete so the event is always on record
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_user_deleted",
    metadata: { target_admin_id: adminUserId, email: target.email, username: target.username },
  });

  try {
    await adminDb.$transaction(async (tx) => {
      // ── Provenance-only nulling — PRESERVE the business/financial/CRM row,
      // drop only the "who did it" attribution. Each of these columns is a
      // RESTRICT / NO-ACTION FK to admin_users that would otherwise BLOCK the
      // delete; we NULL the attribution instead of destroying real data. The
      // columns were made nullable via
      // prisma/admin/sql/2026-06-15_delete_admin_provenance_nullable.up.sql.

      // Null out admin_user_id on audit events (keep the logs)
      await tx.admin_audit_events.updateMany({
        where: { admin_user_id: adminUserId },
        data: { admin_user_id: null },
      });

      // VIP/CRM tag attribution — keep the tag, drop who set it.
      await tx.admin_user_tags.updateMany({
        where: { set_by_admin_id: adminUserId },
        data: { set_by_admin_id: null },
      });
      // Analytics exclusion — keep the user excluded, drop who excluded them.
      await tx.excluded_users.updateMany({
        where: { excluded_by: adminUserId },
        data: { excluded_by: null },
      });
      // Balance 2.0 annotation — keep the value, drop who set it.
      await tx.admin_excluded_user_balance_v2.updateMany({
        where: { set_by_admin_id: adminUserId },
        data: { set_by_admin_id: null },
      });
      // Salary registry / payout log — keep the financial record, drop attribution.
      await tx.salary_employees.updateMany({
        where: { created_by_id: adminUserId },
        data: { created_by_id: null },
      });
      await tx.salary_payouts.updateMany({
        where: { paid_by_id: adminUserId },
        data: { paid_by_id: null },
      });
      // Shift schedule — keep the rota, drop who planned it.
      await tx.admin_shifts.updateMany({
        where: { created_by_id: adminUserId },
        data: { created_by_id: null },
      });
      // creator_deal_estimates is NOT a Prisma model on the admin client
      // (table provisioned outside the schema, NO-ACTION FK). NULL its
      // created_by_id via parameterized raw SQL — keep the estimate, drop
      // who created it.
      await tx.$executeRaw`UPDATE "creator_deal_estimates" SET "created_by_id" = NULL WHERE "created_by_id" = ${adminUserId}::uuid`;

      // ── Pure admin action-logs / orphan rows — safe to DELETE (no business
      // data; consistent with the gift-card / voucher action deletes below).
      await tx.admin_giveaway_actions.deleteMany({ where: { admin_user_id: adminUserId } });
      // admin_balance_limits.admin_user_id is a plain String (no FK, doesn't
      // block) but would otherwise be orphaned — clean it up.
      await tx.admin_balance_limits.deleteMany({ where: { admin_user_id: adminUserId } });

      // Delete all related records with required FKs
      await tx.admin_sessions.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.admin_notes.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.admin_gift_card_actions.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.admin_voucher_actions.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.expenses.deleteMany({ where: { created_by_id: adminUserId } });
      await tx.recurring_expenses.deleteMany({ where: { created_by_id: adminUserId } });

      // Delete the admin user (admin_shift_assignments FK is CASCADE → auto-removed)
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
