import { getExcludedUserIds } from "./fetch";

/**
 * Blacklisted users who remain findable via /users search and CMD+K for
 * every admin. They stay excluded from analytics aggregates and from
 * unfiltered list browsing — only an active search bypasses the filter.
 *
 * Currently empty: every blacklisted user is fully hidden from search for
 * ordinary admins (kartos / `vqsEpQYADwxZ421j2aCV87R2qyIkN6Zd` was removed
 * per owner request 2026-07-01 — must not appear anywhere in the admin).
 * The privileged-admin `includeAllBlacklisted` path in
 * `getExcludedUserIdsForAdminSearch` is unrelated and unchanged.
 */
export const SEARCH_VISIBLE_DESPITE_BLACKLIST: readonly string[] = [] as const;

const SEARCH_VISIBLE_SET = new Set<string>(SEARCH_VISIBLE_DESPITE_BLACKLIST);

export function filterExcludedIdsForSearch(
  excludedUserIds: string[],
): string[] {
  if (SEARCH_VISIBLE_SET.size === 0) return excludedUserIds;
  return excludedUserIds.filter((id) => !SEARCH_VISIBLE_SET.has(id));
}

/**
 * Excluded-user ids to apply on admin user search surfaces (/users box,
 * CMD+K palette). Motha/kotha still see every blacklisted user when
 * searching; other admins skip blacklist entries except
 * {@link SEARCH_VISIBLE_DESPITE_BLACKLIST}.
 */
export async function getExcludedUserIdsForAdminSearch(opts: {
  includeAllBlacklisted: boolean;
  isSearching: boolean;
}): Promise<string[]> {
  if (opts.includeAllBlacklisted && opts.isSearching) return [];
  const all = await getExcludedUserIds();
  if (!opts.isSearching) return all;
  return filterExcludedIdsForSearch(all);
}
