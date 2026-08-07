import { getExcludedUserIds } from "./fetch";

/**
 * Blacklisted users who remain findable via /users search and CMD+K for
 * every admin. They stay excluded from analytics aggregates and from
 * unfiltered list browsing — only an active search bypasses the filter.
 *
 * Currently empty: every blacklisted user is fully hidden from search for
 * ordinary admins (kartos / `vqsEpQYADwxZ421j2aCV87R2qyIkN6Zd` was removed
 * per owner request 2026-07-01 — must not appear anywhere in the admin).
 */
export const SEARCH_VISIBLE_DESPITE_BLACKLIST: readonly string[] = [] as const;

const SEARCH_VISIBLE_SET = new Set<string>(SEARCH_VISIBLE_DESPITE_BLACKLIST);

/**
 * Users that must NEVER surface in ANY admin search — NOT even for owners
 * (motha / kotha), who otherwise bypass the blacklist in search via the
 * `includeAllBlacklisted` path below.
 *
 * This is the HARD-HIDE tier: it closes the privileged-admin search bypass
 * for a specific set the owner has declared invisible to EVERYONE ("nobody,
 * not kotha not motha", owner request 2026-07-04). These ids are also on the
 * `excluded_users` blacklist, so ordinary admins already can't find them and
 * their withdrawals/analytics are suppressed everywhere; THIS const is the
 * extra layer that ALSO removes them from the owner-only search bypass, so no
 * one — of any privilege — can find or reach them through search / CMD+K.
 *
 *   VRqlwTZCJD8wEBa1HHRnGeF8iiKlwh2e — owner request 2026-07-04.
 */
export const ALWAYS_HIDDEN_FROM_SEARCH: readonly string[] = [
  "VRqlwTZCJD8wEBa1HHRnGeF8iiKlwh2e",
] as const;

const ALWAYS_HIDDEN_SET = new Set<string>(ALWAYS_HIDDEN_FROM_SEARCH);

export function filterExcludedIdsForSearch(
  excludedUserIds: string[],
): string[] {
  if (SEARCH_VISIBLE_SET.size === 0) return excludedUserIds;
  return excludedUserIds.filter((id) => !SEARCH_VISIBLE_SET.has(id));
}

/**
 * Ensure every {@link ALWAYS_HIDDEN_FROM_SEARCH} id is present in the
 * returned exclude-list, without duplicating ids already there. The
 * hard-hide set is tiny, so the Set round-trip is negligible.
 */
function withAlwaysHidden(excludedUserIds: string[]): string[] {
  if (ALWAYS_HIDDEN_SET.size === 0) return excludedUserIds;
  const merged = new Set(excludedUserIds);
  for (const id of ALWAYS_HIDDEN_SET) merged.add(id);
  return [...merged];
}

/**
 * Excluded-user ids to apply on admin user search surfaces (/users box,
 * CMD+K palette). Motha/kotha (owners) still see ordinary blacklisted users
 * when searching — EXCEPT the {@link ALWAYS_HIDDEN_FROM_SEARCH} set, which is
 * withheld from EVERYONE regardless of privilege. Other admins skip all
 * blacklist entries except {@link SEARCH_VISIBLE_DESPITE_BLACKLIST}.
 *
 * The returned array is the set of user_ids to EXCLUDE from search results,
 * so the hard-hidden ids are always unioned in on every path.
 */
export async function getExcludedUserIdsForAdminSearch(opts: {
  includeAllBlacklisted: boolean;
  isSearching: boolean;
}): Promise<string[]> {
  // Owner search bypass: owners see all blacklisted users — but the
  // hard-hide set is NEVER bypassed, so it stays excluded even for them.
  if (opts.includeAllBlacklisted && opts.isSearching) {
    return [...ALWAYS_HIDDEN_FROM_SEARCH];
  }
  const all = await getExcludedUserIds();
  if (!opts.isSearching) return withAlwaysHidden(all);
  return withAlwaysHidden(filterExcludedIdsForSearch(all));
}
