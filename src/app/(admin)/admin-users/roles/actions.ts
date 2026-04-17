"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  ALL_CAPABILITY_KEYS,
  isCapabilityKey,
  SYSTEM_ROLES,
} from "@/lib/permissions";

// ---------------------------------------------------------------------------
// admin_roles is a new model (see prisma/admin/schema.prisma). The generated
// Prisma client will only know about it after `npm run admin:migrate` +
// `prisma generate`. Until then we use raw SQL so this module compiles.
// Post-migration these helpers can be rewritten to use adminDb.admin_roles.*.
// ---------------------------------------------------------------------------

export type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  capabilities: string[];
  created_at: string;
  updated_at: string;
  user_count: number;
};

type RawRoleRow = {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  capabilities: string[];
  created_at: Date;
  updated_at: Date;
  user_count: bigint;
};

const SYSTEM_NAMES: ReadonlySet<string> = new Set(SYSTEM_ROLES.map((r) => r.name));

function serialize(row: RawRoleRow): RoleRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    is_system: row.is_system,
    capabilities: row.capabilities,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    user_count: Number(row.user_count),
  };
}

/**
 * Detect pre-migration errors so roles pages degrade gracefully.
 * Postgres codes:
 *   42P01 — undefined_table (admin_roles doesn't exist yet)
 *   42703 — undefined_column (role_id not added to admin_users yet)
 * Prisma maps both to its own P-codes or exposes the pg code on .meta.
 */
function isMissingRolesSchema(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "P2021" || code === "P2022") return true;
  const pgCode = (err as { meta?: { code?: string } })?.meta?.code;
  if (pgCode === "42P01" || pgCode === "42703") return true;
  return /(relation .* does not exist|column .* does not exist)/i.test(err.message);
}

export async function listRoles(): Promise<RoleRow[]> {
  await requireAdmin();
  try {
    const rows = await adminDb.$queryRawUnsafe<RawRoleRow[]>(
      `SELECT r.id::text AS id,
              r.name,
              r.description,
              r.is_system,
              r.capabilities,
              r.created_at,
              r.updated_at,
              COUNT(u.id) AS user_count
         FROM admin_roles r
         LEFT JOIN admin_users u ON u.role_id = r.id
         GROUP BY r.id
         ORDER BY r.is_system DESC, r.name ASC`,
    );
    return rows.map(serialize);
  } catch (err) {
    // Pre-migration: admin_roles table or role_id column not yet applied.
    // Return empty list so the page renders a "run the migration" state
    // instead of a 500.
    if (isMissingRolesSchema(err)) return [];
    throw err;
  }
}

export async function getRole(id: string): Promise<RoleRow | null> {
  await requireAdmin();
  try {
    const rows = await adminDb.$queryRawUnsafe<RawRoleRow[]>(
      `SELECT r.id::text AS id,
              r.name,
              r.description,
              r.is_system,
              r.capabilities,
              r.created_at,
              r.updated_at,
              COUNT(u.id) AS user_count
         FROM admin_roles r
         LEFT JOIN admin_users u ON u.role_id = r.id
         WHERE r.id = $1::uuid
         GROUP BY r.id`,
      id,
    );
    return rows.length > 0 ? serialize(rows[0]) : null;
  } catch (err) {
    // Same pre-migration fallback as listRoles.
    if (isMissingRolesSchema(err)) return null;
    throw err;
  }
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
  .max(ALL_CAPABILITY_KEYS.length)
  .transform((arr) => Array.from(new Set(arr.filter(isCapabilityKey))));

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
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { name, description, capabilities } = parsed.data;

  if (SYSTEM_NAMES.has(name.toLowerCase())) {
    return { ok: false, error: "Cannot use a reserved system role name" };
  }

  try {
    const rows = await adminDb.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO admin_roles (name, description, is_system, capabilities)
       VALUES ($1, $2, FALSE, $3)
       RETURNING id::text AS id`,
      name,
      description ?? null,
      capabilities,
    );
    const id = rows[0].id;

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "admin_role_created",
      metadata: { role_id: id, name, capabilities_count: capabilities.length },
    });

    revalidatePath("/admin-users/roles");
    return { ok: true, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return { ok: false, error: "A role with that name already exists" };
    }
    return { ok: false, error: msg };
  }
}

export async function updateRole(
  input: UpdateRoleInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();
  const parsed = updateRoleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { id, name, description, capabilities } = parsed.data;

  const existing = await getRole(id);
  if (!existing) return { ok: false, error: "Role not found" };
  if (existing.is_system) {
    return { ok: false, error: "System roles cannot be edited" };
  }

  if (name.toLowerCase() !== existing.name.toLowerCase() && SYSTEM_NAMES.has(name.toLowerCase())) {
    return { ok: false, error: "Cannot use a reserved system role name" };
  }

  try {
    await adminDb.$executeRawUnsafe(
      `UPDATE admin_roles
          SET name = $1,
              description = $2,
              capabilities = $3,
              updated_at = NOW()
        WHERE id = $4::uuid`,
      name,
      description ?? null,
      capabilities,
      id,
    );

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "admin_role_updated",
      metadata: {
        role_id: id,
        name,
        capabilities_count: capabilities.length,
      },
    });

    revalidatePath("/admin-users/roles");
    revalidatePath(`/admin-users/roles/${id}`);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return { ok: false, error: "A role with that name already exists" };
    }
    return { ok: false, error: msg };
  }
}

export async function deleteRole(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();

  const existing = await getRole(id);
  if (!existing) return { ok: false, error: "Role not found" };
  if (existing.is_system) {
    return { ok: false, error: "System roles cannot be deleted" };
  }
  if (existing.user_count > 0) {
    return {
      ok: false,
      error: `Role is still assigned to ${existing.user_count} user(s)`,
    };
  }

  await adminDb.$executeRawUnsafe(`DELETE FROM admin_roles WHERE id = $1::uuid`, id);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_role_deleted",
    metadata: { role_id: id, name: existing.name },
  });

  revalidatePath("/admin-users/roles");
  return { ok: true };
}

/**
 * Assign a role to an admin user. Pass `null` to clear the role (user
 * falls back to system-role defaults based on the admin_role enum).
 */
export async function assignRoleToAdminUser(
  adminUserId: string,
  roleId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();

  if (roleId) {
    const exists = await adminDb.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id::text AS id FROM admin_roles WHERE id = $1::uuid`,
      roleId,
    );
    if (exists.length === 0) return { ok: false, error: "Role not found" };
  }

  await adminDb.$executeRawUnsafe(
    `UPDATE admin_users SET role_id = ${roleId ? "$2::uuid" : "NULL"}, updated_at = NOW() WHERE id = $1::uuid`,
    ...(roleId ? [adminUserId, roleId] : [adminUserId]),
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_user_role_assigned",
    metadata: { target_admin_id: adminUserId, role_id: roleId },
  });

  revalidatePath(`/admin-users/${adminUserId}`);
  revalidatePath("/", "layout");
  return { ok: true };
}
