import type { AdminRole } from "@/lib/admin-roles";

type RoleSortableAdmin = {
  isOwner: boolean;
  roles: readonly AdminRole[];
};

const ADMIN_USER_ROLE_ORDER: readonly AdminRole[] = [
  "admin",
  "marketing",
  "pack_creator",
  "support",
];

const ROLE_RANK = new Map(
  ADMIN_USER_ROLE_ORDER.map((role, index) => [role, index + 1]),
);

function rankAdminUser(user: RoleSortableAdmin): number {
  if (user.isOwner) return 0;

  return user.roles.reduce(
    (best, role) => Math.min(best, ROLE_RANK.get(role) ?? Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
}

/**
 * Owner first, followed by the staff-role order used on the Admin Users page.
 * Accounts with multiple roles use their highest-ranked listed role. Any
 * additional role types follow Support while retaining their existing order.
 */
export function compareAdminUsersByRole(
  left: RoleSortableAdmin,
  right: RoleSortableAdmin,
): number {
  return rankAdminUser(left) - rankAdminUser(right);
}
