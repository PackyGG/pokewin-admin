import { getEffectiveRoles } from "@/lib/admin-roles";
import type { SessionPayload } from "@/lib/session";
import { isOwner } from "@/lib/owners";

/**
 * Pack Studio access is owned by the role model. Owners, admins, and Pack
 * Builders enter; every other role stays out. There is no separate workspace
 * toggle or per-user allowlist.
 */
export function canAccessPackStudio(
  session: Pick<SessionPayload, "username" | "role" | "roles" | "isOwner">,
): boolean {
  if (isOwner(session)) return true;
  const roles = getEffectiveRoles(session.role, session.roles);
  return roles.includes("admin") || roles.includes("pack_creator");
}
