import "server-only";

/**
 * Phase C — the SERVER-ONLY glue for the canonical permission write paths.
 *
 * Every admin-side path that persists an admin user's `allowed_pages` now
 * routes through the ONE materializer `computeEffectivePermissions`
 * (src/lib/permissions/materialize.ts) instead of the old divergent
 * `materializeAllowedPages` diff. This module READS a user's persisted
 * permission state from the ADMIN DB (`adminDb`) and delegates all the actual
 * (pure) override math to src/lib/permissions/override.ts — which is therefore
 * unit-testable without a DB (see scripts/__fixtures__/override-materializer.test.ts).
 *
 * BEHAVIOR-PRESERVATION (the owner's hard rule):
 *   - No write path runs at deploy, so no user's `allowed_pages` changes until
 *     an admin individually edits them. The override columns ship empty ('{}').
 *   - When a role-changing action DOES run for a user whose override columns
 *     are still empty, the pure `effectiveOverrideFor` reconstructs the
 *     grants/revokes from the gap between their stored `allowed_pages` and
 *     their baseline (identical to the parity harness), so re-materializing
 *     reproduces the user's current effective access — never snapping them onto
 *     a clean baseline and dropping their manual adjustments.
 */

import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { getEffectiveRoles, isAdminRole } from "@/lib/admin-roles";
import { readAdminUserWithOverrides } from "@/lib/admin-user-roles";
import type { BaselineMap } from "@/lib/role-baselines";
import { sanitizePermissionKeys } from "@/app/(admin)/settings/roles/permissions-utils";
import type {
  PermissionToken,
  PermissionOverride,
} from "@/lib/permissions/types";
import type { PermissionStateCore } from "@/lib/permissions/override";

// Re-export the pure override helpers so callers have one import surface.
export {
  baselineUnionFor,
  deriveOverrideFromAllowedPages,
  effectiveOverrideFor,
  rematerializeForRoleChange,
  materializeForOverride,
} from "@/lib/permissions/override";

/**
 * The persisted permission state of one admin user, as the write paths need
 * it: the effective role list, the custom-role capability tokens, the current
 * `allowed_pages`, and the explicit per-user override columns. Extends the pure
 * {@link PermissionStateCore} with the row `id`.
 *
 * Reads degrade gracefully via `readAdminUserWithOverrides` if the override
 * columns are somehow still absent (they exist in prod, but the wrapper keeps
 * the read safe and the result shape uniform). Returns `null` for an unknown
 * user.
 */
export type UserPermissionState = PermissionStateCore & { id: string };

export async function loadUserPermissionState(
  userId: string,
): Promise<UserPermissionState | null> {
  const row = await readAdminUserWithOverrides(
    () =>
      adminDb.admin_users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          roles: true,
          allowed_pages: true,
          permission_grants: true,
          permission_revokes: true,
          custom_role: { select: { capabilities: true } },
        },
      }),
    () =>
      adminDb.admin_users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          roles: true,
          allowed_pages: true,
          custom_role: { select: { capabilities: true } },
        },
      }),
  );

  if (!row) return null;

  // `readAdminUserWithOverrides` guarantees the override fields exist on the
  // result (real columns on the happy path, injected `[]` on degrade).
  const r = row as {
    id: string;
    role: string;
    roles: string[] | null | undefined;
    allowed_pages: string[];
    permission_grants: string[];
    permission_revokes: string[];
    custom_role: { capabilities: string[] } | null;
  };

  const customRoleTokens: PermissionToken[] = r.custom_role?.capabilities ?? [];
  const override: PermissionOverride = {
    grants: r.permission_grants ?? [],
    revokes: r.permission_revokes ?? [],
  };

  return {
    id: r.id,
    role: r.role,
    roles: getEffectiveRoles(r.role, r.roles),
    customRoleTokens,
    allowedPages: r.allowed_pages,
    override,
  };
}

/**
 * RoleV2 P1 — the DB-backed built-in baseline map (the EDITABLE source of each
 * built-in role's tokens). Reads every `admin_roles` system row
 * (`system_key not null`) and projects `{ system_key → capabilities }` into a
 * {@link BaselineMap}. Threaded into the materializer by the write paths so a
 * future edit of a built-in role's `capabilities` takes effect, while staying
 * BEHAVIOR-NEUTRAL today: the seeded rows are byte-equal to the code
 * `ROLE_BASELINES`, so the returned map produces identical materializer output.
 *
 * `admin` is intentionally EXCLUDED from the map even if a system row exists
 * for it: admin is a hard total-bypass superuser and the materializer
 * short-circuits to `[]` before consulting any baseline, so an `admin` entry
 * could never change its access. Omitting it keeps the map honest (the gate
 * ignores the seeded admin row) and matches the locked design decision.
 *
 * Cached via `unstable_cache` (tag `rolev2-baselines`, 300s) — the built-in
 * baselines change only when an admin edits a system role (a later phase),
 * which will `revalidateTag("rolev2-baselines")`. Degrades to an EMPTY map on
 * ANY error (e.g. the `system_key` column not yet applied) — an empty map
 * means full fallback to the code `ROLE_BASELINES`, i.e. identical behavior.
 * `capabilities` is sanitized (value-token-aware) so a stale token in a row
 * can't leak into a materialized array.
 */
export const getBaselineMap = unstable_cache(
  async (): Promise<BaselineMap> => {
    try {
      const rows = await adminDb.admin_roles.findMany({
        where: { system_key: { not: null } },
        select: { system_key: true, capabilities: true },
      });
      const map: BaselineMap = {};
      for (const row of rows) {
        const key = row.system_key;
        // Skip null (shouldn't happen given the WHERE) and the admin bypass row.
        if (!key || key === "admin" || !isAdminRole(key)) continue;
        map[key] = sanitizePermissionKeys(row.capabilities ?? []);
      }
      return map;
    } catch (err) {
      // The column may not exist yet (applied via prisma db execute, owner-
      // gated). An empty map = full fallback to code ROLE_BASELINES = identical
      // behavior. Never let a baseline-map read crash a write path.
      console.error(
        "[getBaselineMap] falling back to code baselines (DB read failed):",
        err instanceof Error ? err.message : err,
      );
      return {};
    }
  },
  ["rolev2-baseline-map"],
  { tags: ["rolev2-baselines"], revalidate: 300 },
);
