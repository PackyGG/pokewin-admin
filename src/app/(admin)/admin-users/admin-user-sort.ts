import type { AdminRole } from "@/lib/admin-roles";

type RoleSortableAdmin = {
  isOwner: boolean;
  roles: readonly AdminRole[];
};

export type AdminUserGroupKey =
  | "owners"
  | "admins"
  | "marketing"
  | "pack-builders"
  | "support"
  | "other";

export type AdminUserGroup<T extends RoleSortableAdmin> = {
  key: AdminUserGroupKey;
  label: string;
  rows: T[];
};

const ADMIN_USER_ROLE_ORDER: readonly AdminRole[] = [
  "admin",
  "marketing",
  "pack_creator",
  "support",
];

const ADMIN_USER_GROUPS: ReadonlyArray<{
  key: AdminUserGroupKey;
  label: string;
}> = [
  { key: "owners", label: "Owners" },
  { key: "admins", label: "Admins" },
  { key: "marketing", label: "Marketing" },
  { key: "pack-builders", label: "Pack Builders" },
  { key: "support", label: "Support" },
  { key: "other", label: "Other staff" },
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

export function getAdminUserGroup(
  user: RoleSortableAdmin,
): AdminUserGroupKey {
  if (user.isOwner) return "owners";
  if (user.roles.includes("admin")) return "admins";
  if (user.roles.includes("marketing")) return "marketing";
  if (user.roles.includes("pack_creator")) return "pack-builders";
  if (user.roles.includes("support")) return "support";
  return "other";
}

/**
 * Turn the sorted staff list into visible role sections. Empty sections stay
 * hidden so the page remains compact while preserving the requested hierarchy.
 */
export function groupAdminUsersByRole<T extends RoleSortableAdmin>(
  users: readonly T[],
): AdminUserGroup<T>[] {
  const rowsByGroup = new Map<AdminUserGroupKey, T[]>(
    ADMIN_USER_GROUPS.map(({ key }) => [key, []]),
  );

  for (const user of users) {
    rowsByGroup.get(getAdminUserGroup(user))?.push(user);
  }

  return ADMIN_USER_GROUPS.flatMap(({ key, label }) => {
    const rows = rowsByGroup.get(key) ?? [];
    return rows.length > 0 ? [{ key, label, rows }] : [];
  });
}
