import "server-only";

import { eq } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { getEffectiveRoles } from "@/lib/admin-roles";
import { requireAntifraudReadAccess } from "@/lib/require-antifraud-access";
import {
  canAccessAntifraud,
  canManageAntifraud,
  getAntifraudAccessSettings,
  getAntifraudUserAccess,
  type AntifraudAccessSettings,
  type AntifraudUserAccess,
} from "@/lib/antifraud/access";

/**
 * Who may own an account-review case.
 *
 * This is a READ, deliberately not a server action: the review dialog renders
 * the assignee picker during an RSC render, and the server-action gate
 * (`requireAntifraudAccess`) additionally demands a same-origin `Origin`
 * header + spends an action rate-limit slot. A browser never sends `Origin` on
 * a document or RSC GET, so calling the action gate from render always threw
 * and took the whole review surface into the error boundary. Render-time reads
 * use the read gate; the mutation that acts on the choice (`assignReview`)
 * keeps the full action gate and re-checks the assignee itself.
 */

type AssignableUser = Pick<
  typeof admin_users.$inferSelect,
  "username" | "role" | "roles" | "is_active"
>;

export function isAssignableAnalyst(
  target: AssignableUser,
  settings: AntifraudAccessSettings,
  userAccess: AntifraudUserAccess,
): boolean {
  if (!target.is_active) return false;
  const identity = {
    username: target.username,
    role: target.role,
    roles: target.roles,
    isOwner: false,
  };
  if (!canAccessAntifraud(identity, settings, userAccess)) return false;
  return (
    canManageAntifraud(identity) ||
    getEffectiveRoles(target.role, target.roles).includes("support")
  );
}

/** Assignable analysts — active admin or support accounts. */
async function listAssignableAnalysts(): Promise<
  { id: string; label: string }[]
> {
  await requireAntifraudReadAccess();
  try {
    const [users, settings, userAccess] = await Promise.all([
      adminDrizzle.select({
        id: admin_users.id, username: admin_users.username,
        display_username: admin_users.display_username,
        role: admin_users.role, roles: admin_users.roles,
        is_active: admin_users.is_active,
      }).from(admin_users).where(eq(admin_users.is_active, true))
        .orderBy(admin_users.username).limit(200),
      getAntifraudAccessSettings(),
      getAntifraudUserAccess(),
    ]);
    return users.filter((user) =>
      isAssignableAnalyst(user, settings, userAccess),
    ).map((u) => ({
      id: u.id,
      label: u.display_username ?? u.username,
    }));
  } catch {
    return [];
  }
}
