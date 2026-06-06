import "server-only";

import { adminDb } from "@/lib/admin-db";
import type { admin_role } from "@/generated/admin-prisma/client";
import { PACK_CREATOR_DEFAULT_PAGES } from "@/lib/pack-creator/ensure-capabilities";

/**
 * The fixed out-of-the-box baseline `allowed_pages` keys for a built-in
 * system role, used ONLY as the fallback when no existing user of that
 * role exists yet to copy a preset from (the "first user of this role"
 * chicken-and-egg). Mirrors the per-role self-heal back-fills:
 *
 *   - pack_creator → PACK_CREATOR_DEFAULT_PAGES (src/lib/pack-creator/ensure-capabilities.ts)
 *   - support      → /users + /dashboard        (src/lib/support-baseline.ts)
 *
 * `admin` and any role with no fixed baseline return [] — admin bypasses
 * the page list entirely; the rest get configured by an admin afterward
 * via /admin-users or /settings/roles.
 */
function fixedRoleBaseline(role: admin_role): string[] {
  switch (role) {
    case "pack_creator":
      return [...PACK_CREATOR_DEFAULT_PAGES];
    case "support":
      return ["/users", "/dashboard"];
    case "creator_manager":
      return ["/creators"];
    default:
      return [];
  }
}

/**
 * Compute the seed `allowed_pages` for a NEW admin user holding `roles`:
 * the UNION of each role's preset. For each role we prefer copying the
 * preset off an existing user of that role (the live "role preset"),
 * falling back to the fixed baseline above when none exists yet.
 *
 * If `admin` is among the roles the result is [] — admins bypass the page
 * list entirely, so seeding a list would be misleading.
 *
 * This is the multi-role generalization of the single-role inheritance
 * that previously lived inline in createAdminUser.
 */
export async function computeAllowedPagesForRoles(
  roles: readonly admin_role[],
): Promise<string[]> {
  if (roles.includes("admin")) return [];

  const union = new Set<string>();
  for (const role of roles) {
    const existing = await adminDb.admin_users.findFirst({
      where: { role },
      select: { allowed_pages: true },
    });
    const preset = existing?.allowed_pages ?? fixedRoleBaseline(role);
    for (const key of preset) union.add(key);
  }
  return [...union];
}
