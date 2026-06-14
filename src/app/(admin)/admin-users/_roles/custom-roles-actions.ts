"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  ALL_PERMISSION_KEYS,
  sanitizePermissionKeys,
} from "@/app/(admin)/settings/roles/permissions-utils";
import {
  loadUserPermissionState,
  rematerializeForRoleChange,
} from "@/lib/permissions/write-paths";

// ---------------------------------------------------------------------------
// Custom roles = named, reusable permission presets.
//
// A role's `capabilities` array uses the SAME vocabulary as a user's
// `allowed_pages`: page routes ("/users") + `__can_*` capability flags.
// Assigning a role materializes its preset into the user's allowed_pages;
// editing a role re-pushes the baseline to assigned users while keeping
// each user's per-user adjustments (see materializeAllowedPages).
//
// `allowed_pages` remains the single source of truth that every gate
// (requirePageAccess / requireCapability) reads — roles are a convenience
// layer on top, never a parallel enforcement path.
// ---------------------------------------------------------------------------

export type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  /** Legacy permission keys: page routes + `__can_*` capability flags. */
  capabilities: string[];
  created_at: string;
  updated_at: string;
  /** How many admin users currently have this role assigned. */
  user_count: number;
};

// Built-in role names are reserved so a custom role can't shadow them.
// Normalized form: lowercase, whitespace/hyphens → underscores.
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "admin",
  "support",
  "marketing",
  "creator",
  "pack_creator",
  "creator_manager",
]);

function normalizeCustomRoleName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isReservedCustomRoleName(name: string): boolean {
  return RESERVED_NAMES.has(normalizeCustomRoleName(name));
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "P2002") return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return msg.includes("unique") || msg.includes("duplicate");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRoles(): Promise<RoleRow[]> {
  await requireAdmin();
  const roles = await adminDb.admin_roles.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      capabilities: true,
      created_at: true,
      updated_at: true,
      _count: { select: { admin_users: true } },
    },
  });
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    capabilities: r.capabilities,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    user_count: r._count.admin_users,
  }));
}

export async function getRole(id: string): Promise<RoleRow | null> {
  await requireAdmin();
  const r = await adminDb.admin_roles.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      capabilities: true,
      created_at: true,
      updated_at: true,
      _count: { select: { admin_users: true } },
    },
  });
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    capabilities: r.capabilities,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    user_count: r._count.admin_users,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const roleNameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(50, "Name must be at most 50 characters")
  .regex(/^[A-Za-z0-9 _-]+$/, "Only letters, digits, spaces, _ and -");

const capabilitiesSchema = z
  .array(z.string())
  .max(ALL_PERMISSION_KEYS.length)
  // Drop anything that isn't a recognized page route / `__can_*` key.
  .transform((arr) => sanitizePermissionKeys(arr));

const createRoleSchema = z.object({
  name: roleNameSchema,
  description: z.string().trim().max(500).optional().nullable(),
  capabilities: capabilitiesSchema,
});

const updateRoleSchema = z.object({
  id: z.string().uuid(),
  name: roleNameSchema,
  description: z.string().trim().max(500).optional().nullable(),
  capabilities: capabilitiesSchema,
});

export type CreateRoleInput = z.input<typeof createRoleSchema>;
export type UpdateRoleInput = z.input<typeof updateRoleSchema>;

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createRole(
  input: CreateRoleInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = await requireAdmin();
  const parsed = createRoleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { name, description, capabilities } = parsed.data;
  if (isReservedCustomRoleName(name)) {
    return { ok: false, error: "That name is reserved for a built-in role" };
  }

  try {
    const role = await adminDb.admin_roles.create({
      data: {
        name,
        description: description ?? null,
        is_system: false,
        capabilities,
      },
      select: { id: true },
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "admin_role_created",
      metadata: { role_id: role.id, name, capabilities_count: capabilities.length },
    });

    revalidatePath("/admin-users");
    return { ok: true, id: role.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "A role with that name already exists" };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateRole(
  input: UpdateRoleInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();
  const parsed = updateRoleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { id, name, description, capabilities } = parsed.data;

  const existing = await adminDb.admin_roles.findUnique({
    where: { id },
    select: { id: true, name: true, capabilities: true },
  });
  if (!existing) return { ok: false, error: "Role not found" };

  if (
    normalizeCustomRoleName(name) !== normalizeCustomRoleName(existing.name) &&
    isReservedCustomRoleName(name)
  ) {
    return { ok: false, error: "That name is reserved for a built-in role" };
  }

  // Refresh the role baseline for every assigned user. Phase C: route through
  // the ONE canonical materializer (computeEffectivePermissions) instead of
  // the old materializeAllowedPages diff. Each user's per-user override is
  // PRESERVED — their explicit grants/revokes if set, else the override
  // derived from the gap between their current allowed_pages and their OLD
  // baseline (built-in roles ∪ the role's OLD capabilities). Re-materializing
  // against the NEW custom-role capabilities keeps every manual adjustment.
  const assigned = await adminDb.admin_users.findMany({
    where: { role_id: id },
    select: { id: true },
  });

  // Precompute each assigned user's re-materialized allowed_pages (reads run
  // outside the write transaction; the writes are batched atomically below).
  const refreshed: { id: string; allowedPages: string[] }[] = [];
  for (const u of assigned) {
    const state = await loadUserPermissionState(u.id);
    if (!state) continue;
    const { allowedPages } = rematerializeForRoleChange(
      state,
      state.roles,
      capabilities, // the NEW custom-role capability set
    );
    refreshed.push({ id: u.id, allowedPages });
  }

  try {
    await adminDb.$transaction([
      adminDb.admin_roles.update({
        where: { id },
        data: { name, description: description ?? null, capabilities },
      }),
      ...refreshed.map((u) =>
        adminDb.admin_users.update({
          where: { id: u.id },
          data: { allowed_pages: u.allowedPages },
          select: { id: true },
        }),
      ),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "A role with that name already exists" };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_role_updated",
    metadata: {
      role_id: id,
      name,
      capabilities_count: capabilities.length,
      users_refreshed: assigned.length,
    },
  });

  revalidatePath("/admin-users");
  revalidatePath(`/admin-users/roles/${id}`);
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteRole(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();

  const existing = await adminDb.admin_roles.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!existing) return { ok: false, error: "Role not found" };

  // FK is onDelete: SetNull — assigned users keep their current
  // allowed_pages (their effective permissions are unchanged), they just
  // lose the role link and become purely per-user managed.
  await adminDb.admin_roles.delete({ where: { id }, select: { id: true } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_role_deleted",
    metadata: { role_id: id, name: existing.name },
  });

  revalidatePath("/admin-users");
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Assign a custom role to an admin user (or pass `null` to clear it).
 *
 * Phase C: the user's `allowed_pages` is recomputed through the ONE canonical
 * materializer (computeEffectivePermissions). The NEW custom-role capabilities
 * become part of the baseline; the user's per-user override is PRESERVED —
 * their explicit grants/revokes if set, else the override derived from the gap
 * between their current allowed_pages and their OLD baseline (built-in roles ∪
 * OLD custom-role capabilities), so manual adjustments survive. Clearing the
 * role drops the custom-role contribution from the baseline and re-materializes
 * with the built-in baseline alone. Real admins are rejected — they bypass the
 * gate, so a custom-role baseline is meaningless for them.
 */
export async function assignRoleToAdminUser(
  adminUserId: string,
  roleId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();

  // Full permission state — reads the OLD custom-role tokens + the per-user
  // override columns, so the derived override is relative to the OLD baseline.
  const state = await loadUserPermissionState(adminUserId);
  if (!state) return { ok: false, error: "Admin user not found" };
  if (state.roles.includes("admin")) {
    return {
      ok: false,
      error: "Admin users already have full access — roles don't apply",
    };
  }

  // New preset (the role being assigned, if any). Empty when clearing.
  let newPreset: string[] = [];
  if (roleId) {
    const newRole = await adminDb.admin_roles.findUnique({
      where: { id: roleId },
      select: { capabilities: true },
    });
    if (!newRole) return { ok: false, error: "Role not found" };
    newPreset = newRole.capabilities;
  }

  // Re-materialize with the NEW custom-role tokens; built-in roles unchanged.
  const { allowedPages: newAllowed } = rematerializeForRoleChange(
    state,
    state.roles,
    newPreset,
  );

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: { role_id: roleId, allowed_pages: newAllowed },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_user_role_assigned",
    metadata: { target_admin_id: adminUserId, role_id: roleId },
  });

  revalidatePath(`/admin-users/${adminUserId}`);
  revalidatePath("/", "layout");
  return { ok: true };
}
