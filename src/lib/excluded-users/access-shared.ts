export const EXCLUDED_USERS_ACCESS_ALLOWLIST = ["motha", "hifoen"] as const;

const EXCLUDED_USERS_ACCESS_USERNAMES = new Set<string>(
  EXCLUDED_USERS_ACCESS_ALLOWLIST,
);

/** This narrow grant does not confer owner or role-wide privileges. */
export function hasExcludedUsersAccess(
  username: string | null | undefined,
): boolean {
  return EXCLUDED_USERS_ACCESS_USERNAMES.has(
    (username ?? "").trim().toLowerCase(),
  );
}
