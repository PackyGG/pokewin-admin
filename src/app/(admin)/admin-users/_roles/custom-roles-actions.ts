"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  ALL_PERMISSION_KEYS,
  sanitizePermissionKeys,
} from "@/app/(admin)/settings/roles/permissions-utils";
import {
  loadUserPermissionState,
  loadUserPermissionStates,
  rematerializeForRoleChange,
  getBaselineMap,
} from "@/lib/permissions/write-paths";
import { normalizeLandingRouteInput } from "@/lib/role-landing";
import { isPostgresError } from "@/lib/postgres-errors";

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
  if (isPostgresError(err, "23505")) return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return msg.includes("unique") || msg.includes("duplicate");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRoles(): Promise<RoleRow[]> {
  await requireAdmin();
  const roles = (await adminDrizzle.execute<{
    id: string; name: string; description: string | null; capabilities: string[];
    created_at: Date | string; updated_at: Date | string; user_count: string;
  }>(sql`
    SELECT r.id::text, r.name, r.description, r.capabilities,
           r.created_at, r.updated_at, COUNT(u.id)::text AS user_count
    FROM admin_roles r
    LEFT JOIN admin_users u ON u.role_id = r.id
    GROUP BY r.id
    ORDER BY r.name ASC
  `)).rows;
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    capabilities: r.capabilities,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
    user_count: Number(r.user_count),
  }));
}

/**
 * The assignable role presets for the per-user "Role preset" select on
 * /admin-users/[id]: every CUSTOM role (`is_system = false`), id + name only.
 * The 6 enum roles are assigned via the system-role chip editor (the `role` /
 * `roles[]` columns), NOT via `role_id` — assigning a system row as a `role_id`
 * would double-count its baseline (the user already gets it from the enum). So
 * the preset list is the custom roles, which is exactly what `role_id` links to.
 * Admin-gated read.
 */
export async function listAssignablePresets(): Promise<
  { id: string; name: string }[]
> {
  await requireAdmin();
  const rows = (await adminDrizzle.execute<{ id: string; name: string }>(sql`
    SELECT id::text, name FROM admin_roles
    WHERE NOT is_system
    ORDER BY name ASC
  `)).rows;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export async function getRole(id: string): Promise<RoleRow | null> {
  await requireAdmin();
  const r = (await adminDrizzle.execute<{
    id: string; name: string; description: string | null; capabilities: string[];
    created_at: Date | string; updated_at: Date | string; user_count: string;
  }>(sql`
    SELECT r.id::text, r.name, r.description, r.capabilities,
           r.created_at, r.updated_at, COUNT(u.id)::text AS user_count
    FROM admin_roles r
    LEFT JOIN admin_users u ON u.role_id = r.id
    WHERE r.id = ${id}::uuid
    GROUP BY r.id
  `)).rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    capabilities: r.capabilities,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
    user_count: Number(r.user_count),
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
  // Optional per-role landing route (RoleV2 P4). `null` clears it (→ today's
  // routing); a non-empty value is validated against the known ADMIN_PAGES keys
  // (redirect-loop guard). `undefined` leaves the column untouched.
  landingRoute: z.string().trim().nullable().optional(),
  // 2FA TOTP code — required, matching every other role/permission save
  // (built-in caps, per-user permissions, role limits are all 2FA-gated).
  code: z.string().trim().min(1, "TOTP code is required"),
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
    const role = (await adminDrizzle.execute<{ id: string }>(sql`
      INSERT INTO admin_roles (name, description, is_system, capabilities)
      VALUES (${name}, ${description ?? null}, false, ${sql.param(capabilities)})
      RETURNING id::text
    `)).rows[0]!;

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

  const { id, name, description, capabilities, landingRoute, code } = parsed.data;

  // 2FA: verify the acting admin's TOTP before any capability/name mutation
  // (same gate as updateBuiltInRole / updateUserPermissions / setRoleLimits).
  await require2FA(session.userId, code);

  // Validate the landing route (if provided): a known ADMIN_PAGES key, empty
  // (= clear), or reject. `undefined` leaves the column untouched.
  let landingRouteToWrite: string | null | undefined;
  if (landingRoute !== undefined) {
    const normalized = normalizeLandingRouteInput(landingRoute);
    if (normalized === undefined) {
      return {
        ok: false,
        error: "Landing route must be a known admin page, or empty",
      };
    }
    landingRouteToWrite = normalized;
  }

  const existing = (await adminDrizzle.execute<{
    id: string; name: string; capabilities: string[]; is_system: boolean;
  }>(sql`
    SELECT id::text, name, capabilities, is_system
    FROM admin_roles WHERE id = ${id}::uuid LIMIT 1
  `)).rows[0];
  if (!existing) return { ok: false, error: "Role not found" };

  // HARD GUARD: this action edits CUSTOM roles only. A built-in (system) row's
  // capabilities are edited exclusively through `updateBuiltInRole`, which
  // re-materializes holders against the baseline map and busts the baseline
  // cache. Routing a system row through here would write its `capabilities`
  // WITHOUT busting `rolev2-baselines` (the gate reads the stale baseline) and
  // would treat its enum holders as `role_id`-assigned (they are not) — so it
  // is rejected. The UI already hides this path for system rows; this is the
  // server boundary.
  if (existing.is_system) {
    return {
      ok: false,
      error:
        "Built-in roles are edited from their own editor (name + capabilities), not here.",
    };
  }

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
  const assigned = (await adminDrizzle.execute<{ id: string }>(sql`
    SELECT id::text FROM admin_users WHERE role_id = ${id}::uuid
  `)).rows;

  // Precompute each assigned user's re-materialized allowed_pages (reads run
  // outside the write transaction; the writes are batched atomically below).
  // RoleV2 P1: read the DB-backed built-in baseline map ONCE and thread it
  // through every re-materialization (byte-equal to code at migration →
  // identical output).
  const baselines = await getBaselineMap();
  const refreshed: {
    id: string;
    allowedPages: string[];
    expectedAllowedPages: readonly string[];
    expectedGrants: readonly string[];
    expectedRevokes: readonly string[];
  }[] = [];
  const assignedStates = await loadUserPermissionStates(
    assigned.map((user) => user.id),
  );
  for (const state of assignedStates) {
    const { allowedPages } = rematerializeForRoleChange(
      state,
      state.roles,
      capabilities, // the NEW custom-role capability set
      baselines,
    );
    refreshed.push({
      id: state.id,
      allowedPages,
      expectedAllowedPages: state.allowedPages,
      expectedGrants: state.override.grants,
      expectedRevokes: state.override.revokes,
    });
  }

  try {
    await adminDrizzle.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE admin_roles
        SET name = ${name}, description = ${description ?? null},
            capabilities = ${sql.param(capabilities)},
            landing_route = CASE WHEN ${landingRouteToWrite !== undefined}
              THEN ${landingRouteToWrite ?? null} ELSE landing_route END,
            updated_at = NOW()
        WHERE id = ${id}::uuid
      `);
      if (refreshed.length > 0) {
        const updatedUsers = await tx.execute(sql`
          UPDATE admin_users au
          SET allowed_pages = patch.allowed_pages, updated_at = NOW()
          FROM jsonb_to_recordset(
            ${JSON.stringify(
              refreshed.map((user) => ({
                id: user.id,
                allowed_pages: user.allowedPages,
                expected_allowed_pages: user.expectedAllowedPages,
                expected_grants: user.expectedGrants,
                expected_revokes: user.expectedRevokes,
              })),
            )}::jsonb
          ) AS patch(
            id uuid,
            allowed_pages text[],
            expected_allowed_pages text[],
            expected_grants text[],
            expected_revokes text[]
          )
          WHERE au.id = patch.id
            AND COALESCE(au.allowed_pages, ARRAY[]::text[]) = patch.expected_allowed_pages
            AND COALESCE(au.permission_grants, ARRAY[]::text[]) = patch.expected_grants
            AND COALESCE(au.permission_revokes, ARRAY[]::text[]) = patch.expected_revokes
        `);
        if (updatedUsers.rowCount !== refreshed.length) {
          throw new Error(
            "A user's permissions changed concurrently; reload and retry",
          );
        }
      }
    });
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
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();

  // 2FA: deleting a role is destructive (drops the preset + unlinks holders) —
  // gate it like every other role/permission save. Previously this action had
  // NO 2FA; adding one only BLOCKS the dangerous path, never widens access.
  await require2FA(session.userId, code);

  const existing = (await adminDrizzle.execute<{
    id: string; name: string; is_system: boolean;
  }>(sql`
    SELECT id::text, name, is_system
    FROM admin_roles WHERE id = ${id}::uuid LIMIT 1
  `)).rows[0];
  if (!existing) return { ok: false, error: "Role not found" };

  // HARD GUARD: the six built-in (system) roles are the protected, undeletable
  // backbone — they stay enum-wired underneath. Only custom presets are
  // deletable. The UI disables Delete on system rows; this is the server
  // boundary so a system row can never be dropped.
  if (existing.is_system) {
    return { ok: false, error: "Built-in roles can't be deleted." };
  }

  // FK is onDelete: SetNull — assigned users keep their current
  // allowed_pages (their effective permissions are unchanged), they just
  // lose the role link and become purely per-user managed.
  await adminDrizzle.execute(sql`DELETE FROM admin_roles WHERE id = ${id}::uuid`);

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
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();

  // 2FA: assigning/clearing a role rewrites the target user's allowed_pages
  // (their effective access changes) — gate it like every other access save.
  await require2FA(session.userId, code);

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
    const newRole = (await adminDrizzle.execute<{ capabilities: string[] }>(sql`
      SELECT capabilities FROM admin_roles
      WHERE id = ${roleId}::uuid LIMIT 1
    `)).rows[0];
    if (!newRole) return { ok: false, error: "Role not found" };
    newPreset = newRole.capabilities;
  }

  // Re-materialize with the NEW custom-role tokens; built-in roles unchanged.
  // RoleV2 P1: thread the DB-backed built-in baseline map (byte-equal to code
  // at migration → identical output).
  const baselines = await getBaselineMap();
  const { allowedPages: newAllowed } = rematerializeForRoleChange(
    state,
    state.roles,
    newPreset,
    baselines,
  );

  await adminDrizzle.execute(sql`
    UPDATE admin_users
    SET role_id = ${roleId}::uuid,
        allowed_pages = ${sql.param(newAllowed)},
        updated_at = NOW()
    WHERE id = ${adminUserId}::uuid
  `);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_user_role_assigned",
    metadata: { target_admin_id: adminUserId, role_id: roleId },
  });

  revalidatePath(`/admin-users/${adminUserId}`);
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Duplicate a role (built-in OR custom) into a NEW CUSTOM role — the source's
 * `capabilities` + the six limit columns are copied verbatim onto a fresh
 * `admin_roles` row. The clone is ALWAYS a plain custom preset (`is_system =
 * false`, `system_key = null`, no `landing_route`): a built-in's identity is its
 * enum key and there is exactly one row per enum value, so the copy can only be
 * a custom role. No user is touched (a brand-new role has no holders).
 *
 * 2FA-gated (matches every other role write). The name is validated like
 * `createRole` (reserved-name + uniqueness rejected). Returns the new id so the
 * caller can open its editor (pre-filled, since the editor reads from the DB).
 */
export async function duplicateRole(
  sourceId: string,
  newName: string,
  code: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = await requireAdmin();
  await require2FA(session.userId, code);

  const nameParsed = roleNameSchema.safeParse(newName);
  if (!nameParsed.success) {
    return {
      ok: false,
      error: nameParsed.error.issues[0]?.message ?? "Invalid name",
    };
  }
  const name = nameParsed.data;
  if (isReservedCustomRoleName(name)) {
    return { ok: false, error: "That name is reserved for a built-in role" };
  }

  // Read the source's caps + limits (works for a system or custom row).
  const source = (await adminDrizzle.execute<{
    capabilities: string[];
    description: string | null;
    balance_limit_daily: string | null;
    balance_limit_weekly: string | null;
    balance_limit_monthly: string | null;
    issuance_limit_daily: string | null;
    issuance_limit_weekly: string | null;
    issuance_limit_monthly: string | null;
  }>(sql`
    SELECT capabilities, description,
           balance_limit_daily::text, balance_limit_weekly::text,
           balance_limit_monthly::text, issuance_limit_daily::text,
           issuance_limit_weekly::text, issuance_limit_monthly::text
    FROM admin_roles WHERE id = ${sourceId}::uuid LIMIT 1
  `)).rows[0];
  if (!source) return { ok: false, error: "Source role not found" };

  // Sanitize the copied capabilities the same way createRole does (value-token
  // aware; drops anything unknown). The clone is a clean custom preset.
  const capabilities = sanitizePermissionKeys([...source.capabilities]);

  try {
    const role = (await adminDrizzle.execute<{ id: string }>(sql`
      INSERT INTO admin_roles (
        name, description, is_system, capabilities,
        balance_limit_daily, balance_limit_weekly, balance_limit_monthly,
        issuance_limit_daily, issuance_limit_weekly, issuance_limit_monthly
      ) VALUES (
        ${name}, ${source.description}, false, ${sql.param(capabilities)},
        ${source.balance_limit_daily}::numeric,
        ${source.balance_limit_weekly}::numeric,
        ${source.balance_limit_monthly}::numeric,
        ${source.issuance_limit_daily}::numeric,
        ${source.issuance_limit_weekly}::numeric,
        ${source.issuance_limit_monthly}::numeric
      )
      RETURNING id::text
    `)).rows[0]!;

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "admin_role_created",
      metadata: {
        role_id: role.id,
        name,
        capabilities_count: capabilities.length,
        duplicated_from: sourceId,
      },
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
