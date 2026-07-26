"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  isAdminRole,
  type AdminRole,
} from "@/lib/admin-roles";
import {
  ALL_PERMISSION_KEYS,
  sanitizePermissionKeys,
} from "@/app/(admin)/settings/roles/permissions-utils";
import {
  loadUserPermissionStates,
  effectiveOverrideFor,
  materializeForOverride,
  getBaselineMap,
} from "@/lib/permissions/write-paths";
import { normalizeLandingRouteInput } from "@/lib/role-landing";
import { isPostgresError } from "@/lib/postgres-errors";

// ---------------------------------------------------------------------------
// RoleV2 P2 — EDIT a BUILT-IN (system) role's capabilities.
//
// A built-in role lives as an `admin_roles` row with `is_system = true`, keyed
// by the `system_key` enum value (NOT `name`). Its `capabilities` array is the
// EDITABLE source the materializer reads via `getBaselineMap()` (the DB-backed
// `BaselineMap`, cached under tag `rolev2-baselines`). Editing it must:
//
//   1. persist the new `capabilities` (+ optional `description`) on the system
//      row, then bust the baseline-map cache, and
//   2. re-materialize `allowed_pages` for EVERY admin user whose effective
//      roles include this built-in — through the ONE canonical materializer
//      (`computeEffectivePermissions`) so the runtime gate (which still reads
//      `allowed_pages`) sees the new baseline.
//
// BEHAVIOR-PRESERVATION (the owner's hard rule): each affected user's per-user
// override (`permission_grants` / `permission_revokes`) MUST survive the edit.
// A user who was manually granted /packs or had /chat revoked keeps that
// adjustment relative to the role's NEW baseline. The composition that achieves
// this is the SAME shape the custom-role editor (`updateRole`) uses, but split
// across the baseline change:
//
//   • DERIVE the override against the OLD baseline map (the user's stored
//     `allowed_pages` was materialized against it), then
//   • MATERIALIZE against the NEW baseline map.
//
// Deriving against the NEW map would be a BUG: it would treat the gap between
// the user's old-baseline `allowed_pages` and the new baseline as manual
// grants/revokes and freeze them onto the OLD set instead of adopting the edit.
//
// `admin` is REJECTED: it is a total-bypass superuser (the materializer
// short-circuits to `[]` before consulting any baseline), so an edited admin
// baseline could neither widen nor narrow its access — recording one would only
// mislead. Admin users are also skipped when re-materializing other roles.
//
// This is a NEW file on purpose — it is NOT crammed into the custom-roles
// hotspot (`custom-roles-actions.ts`).
// ---------------------------------------------------------------------------

const updateBuiltInRoleSchema = z.object({
  capabilities: z
    .array(z.string())
    .max(ALL_PERMISSION_KEYS.length)
    // Drop anything that isn't a recognized page route / `__can_*` key / value
    // token — value-token-aware, identical to every other write path.
    .transform((arr) => sanitizePermissionKeys(arr)),
  description: z.string().trim().max(500).optional().nullable(),
  // Optional DISPLAY name. RoleV2 P3: the 5 non-admin system rows can be
  // renamed cosmetically WITHOUT changing identity — `system_key`/enum stays
  // the role's identity everywhere (gate, baselines, landing). Omit to leave
  // the name unchanged (a pure capability/description edit). `admin` is rejected
  // wholesale below, so its name is never writable here.
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters")
    .regex(/^[A-Za-z0-9 _-]+$/, "Only letters, digits, spaces, _ and -")
    .optional(),
  // Optional per-role landing route (RoleV2 P4). `null` clears it (→ today's
  // routing). Validated against the known ADMIN_PAGES keys so an invalid value
  // can never cause a redirect loop. `undefined` leaves it untouched.
  landingRoute: z.string().trim().nullable().optional(),
  // 2FA TOTP code — required, matches the per-user editor's `updateUserPermissions`.
  code: z.string().trim().min(1, "TOTP code is required"),
});

export type UpdateBuiltInRoleInput = z.input<typeof updateBuiltInRoleSchema>;

/**
 * Update a built-in (system) role's capabilities and re-materialize every
 * affected admin user, preserving their per-user overrides.
 *
 * @param systemKey  The built-in `AdminRole` to edit. `"admin"` is rejected.
 * @param input      `{ capabilities, description?, code }` — `code` is the
 *                   acting admin's TOTP (2FA), required.
 * @returns `{ usersRematerialized }` — how many admin users had their
 *          `allowed_pages` rewritten (for the future save-preview UI).
 *
 * Guards: admin-only caller (`requireAdmin`), 2FA (`require2FA`), and a hard
 * reject of `systemKey === "admin"`. Audited via `createAdminAuditEvent`
 * (`admin_builtin_role_updated`) with NON-secret metadata only.
 */
export async function updateBuiltInRole(
  systemKey: AdminRole,
  input: UpdateBuiltInRoleInput,
): Promise<{ usersRematerialized: number }> {
  const session = await requireAdmin();

  // --- Validate input (sanitizes capabilities, requires a TOTP code) --------
  const parsed = updateBuiltInRoleSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { capabilities, description, name, landingRoute, code } = parsed.data;

  // Validate the landing route (if provided): a known ADMIN_PAGES key, empty
  // (= clear), or reject. Guards against redirect loops. `undefined` = leave
  // the column untouched.
  let landingRouteToWrite: string | null | undefined;
  if (landingRoute !== undefined) {
    const normalized = normalizeLandingRouteInput(landingRoute);
    if (normalized === undefined) {
      throw new Error("Landing route must be a known admin page, or empty");
    }
    landingRouteToWrite = normalized; // string (valid key) or null (cleared)
  }

  // --- 2FA: verify the acting admin's TOTP (same pattern as the per-user
  //     permission editor's `updateUserPermissions`). -----------------------
  await require2FA(session.userId, code);

  // --- Reject editing the admin role (total bypass — an edit is meaningless
  //     and recording one could mislead). -----------------------------------
  if (systemKey === "admin") {
    throw new Error(
      "The admin role can't be edited — it bypasses all checks",
    );
  }
  // Defense-in-depth: only a recognized built-in enum value can be a system row.
  if (!isAdminRole(systemKey)) {
    throw new Error("Unknown built-in role");
  }

  // --- Locate the system row for this built-in. -----------------------------
  const systemRow = (await adminDrizzle.execute<{
    id: string;
    is_system: boolean;
  }>(sql`
    SELECT id::text, is_system
    FROM admin_roles
    WHERE system_key = ${systemKey}
    LIMIT 1
  `)).rows[0];
  if (!systemRow || !systemRow.is_system) {
    throw new Error("Built-in role not found");
  }

  // --- Snapshot the OLD baseline map BEFORE the write. Each affected user's
  //     stored `allowed_pages` was materialized against this, so the override
  //     derivation for a never-edited user must use it (NOT the new map).
  const oldBaselines = await getBaselineMap();

  // --- Collect every admin user whose effective roles include this built-in.
  //     `getEffectiveRoles` is the in-memory predicate (handles the singular
  //     `role` column + the additive `roles[]` array). We read all candidate
  //     rows (only role columns) and filter in code — there is no SQL operator
  //     for "membership in the normalized effective-role set". Admins are
  //     skipped (they bypass the gate; their `allowed_pages` stays empty `[]`).
  const affectedIds = (await adminDrizzle.execute<{ id: string }>(sql`
    SELECT id::text
    FROM admin_users
    WHERE NOT (role = 'admin' OR 'admin'::admin_role = ANY(roles))
      AND (
        role = ${systemKey}::admin_role
        OR ${systemKey}::admin_role = ANY(roles)
      )
  `)).rows.map((row) => row.id);

  // --- Build the NEW baseline map WITHOUT waiting for the cache to expire:
  //     start from the OLD map and overlay this role's sanitized capabilities.
  //     (The DB write below makes this durable; `getBaselineMap()` will return
  //     the same thing after `revalidateTag`.) Using a locally-overlaid map
  //     keeps the re-materialization deterministic w.r.t. the value we just
  //     wrote, regardless of cache timing.
  const newBaselines = { ...oldBaselines, [systemKey]: capabilities };

  // --- Precompute each affected user's re-materialized `allowed_pages`:
  //     DERIVE the override against the OLD baseline, MATERIALIZE against the
  //     NEW baseline — preserving explicit `permission_grants`/`permission_revokes`
  //     (or the override derived from their current `allowed_pages` vs the OLD
  //     baseline). Reads run OUTSIDE the write transaction; writes are batched
  //     atomically below. -----------------------------------------------------
  const refreshed: {
    id: string;
    allowedPages: string[];
    expectedAllowedPages: readonly string[];
    expectedGrants: readonly string[];
    expectedRevokes: readonly string[];
  }[] = [];
  const affectedStates = await loadUserPermissionStates(affectedIds);
  for (const state of affectedStates) {
    // Extra guard: never touch an admin (membership filter already excludes
    // them, but `loadUserPermissionState` re-reads the canonical role set).
    if (state.roles.includes("admin")) continue;
    const override = effectiveOverrideFor(state, oldBaselines);
    const allowedPages = materializeForOverride(state, override, newBaselines);
    refreshed.push({
      id: state.id,
      allowedPages,
      expectedAllowedPages: state.allowedPages,
      expectedGrants: state.override.grants,
      expectedRevokes: state.override.revokes,
    });
  }

  // --- Persist atomically: the system row's new capabilities (+ description if
  //     supplied) AND every affected user's re-materialized `allowed_pages`, so
  //     the editable source and the materialized cache never diverge. ---------
  try {
    await adminDrizzle.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE admin_roles
        SET capabilities = ${capabilities},
            description = CASE WHEN ${description !== undefined} THEN ${description ?? null} ELSE description END,
            name = CASE WHEN ${name !== undefined} THEN ${name ?? ""} ELSE name END,
            landing_route = CASE WHEN ${landingRouteToWrite !== undefined} THEN ${landingRouteToWrite ?? null} ELSE landing_route END,
            updated_at = NOW()
        WHERE system_key = ${systemKey}
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
    // The only user-correctable failure here is a DISPLAY-name collision
    // (`admin_roles.name` is UNIQUE) when renaming a system row to a name
    // another role already uses. Surface a clear message; rethrow anything else.
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    if (
      name !== undefined &&
      (isPostgresError(err, "23505") || msg.includes("unique") || msg.includes("duplicate"))
    ) {
      throw new Error("A role with that name already exists");
    }
    throw err;
  }

  // --- Bust the baseline-map cache so the next `getBaselineMap()` read (and
  //     thus every subsequent write path / gate refresh) sees the new tokens.
  revalidateTag("rolev2-baselines");

  // --- Audit (NON-secret metadata only: the role key + counts, never tokens
  //     that could leak a capability layout or the TOTP). --------------------
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_builtin_role_updated",
    metadata: {
      system_key: systemKey,
      capabilities_count: capabilities.length,
      users_rematerialized: refreshed.length,
    },
  });

  // --- Revalidate the admin-users surface + the global layout (sidebar /
  //     allowed-pages gate consumes the materialized arrays). ----------------
  revalidatePath("/admin-users");
  revalidatePath("/", "layout");

  return { usersRematerialized: refreshed.length };
}
