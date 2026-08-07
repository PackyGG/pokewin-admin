import { z } from "zod";

/**
 * Search-param validation for the /users LIST page.
 *
 * Why this exists: the page used to read its params with raw
 * `Number(params.page) || 1` / pass-through strings and hand them
 * straight to `getUsers`. That path crashed the whole list on a single
 * malformed param:
 *
 *   • `?page=-5`   → `Number("-5") || 1` = -5 → the raw-SQL sort builds
 *                    `OFFSET (page - 1) * perPage` = a NEGATIVE offset →
 *                    Postgres throws `OFFSET must not be negative` and
 *                    the segment-level error.tsx takes over (the "Couldn't
 *                    load the user list" crash the owner reported).
 *   • `?perPage=-1`→ negative `LIMIT` → Postgres throws likewise.
 *   • `?page=1e10` → `Number("1e10")` = 10,000,000,000 → a 10-billion-row
 *                    OFFSET — a pathological scan that hangs the query.
 *
 * The numeric params are the genuine "single bad filter parameter" crash
 * vector (they reach the LIMIT/OFFSET literals). The string filter /
 * sort params are ALSO validated here so a bad/unknown value falls back
 * to the default at the page boundary and never reaches the query as
 * garbage — defense-in-depth on top of the allowlists `getUsers` already
 * applies internally.
 *
 * Mirrors the canonical pattern in
 * `src/app/(admin)/creators/_lib/search-params.ts`: a Zod schema parsed
 * with `safeParse`, where any invalid value silently falls back to the
 * schema defaults so a fuzzed URL can never break the render.
 */

/**
 * Sort orders the list understands. Anything else falls back to `desc`
 * (the list's natural newest-first default), matching the query's own
 * `sortOrder === "asc" ? "asc" : "desc"` behaviour.
 */
export const UsersSortOrder = z.enum(["asc", "desc"]);
export type UsersSortOrder = z.infer<typeof UsersSortOrder>;

/**
 * Every sort key `getUsers` knows how to ORDER BY — the union of its
 * Standard sorts (created_at / email / username / role / country /
 * affiliate_code / status / balance / totalDeposited / totalWagered) and
 * its raw-SQL computed sorts (pnl / totalWithdrawn / netHoldings /
 * depositCount). Kept in sync with the `userSortFields` /
 * `balanceSortFields` / `rawSqlSorts` sets in
 * `src/lib/queries/users-list.ts`. An unknown key falls back to
 * `created_at` (the query's own default), so the validated value can
 * never select a non-existent column.
 *
 * `inventoryValue` and `lockedBalance` were removed (2026-07-08) along with
 * the standalone "Inventory" / "Vault / Locked" columns and the "Top vault /
 * locked" toolbar shortcut — no UI control can produce these sort keys
 * anymore, so they're dropped from the allowlist rather than left as
 * unreachable values. The underlying computation still feeds `netHoldings`.
 */
export const UsersSortBy = z.enum([
  // Standard column sorts
  "created_at",
  "email",
  "username",
  "role",
  "country",
  // "Code / Affiliate" column — plain scalar column sort, same tier as
  // country/role above.
  "affiliate_code",
  "status",
  // balance-relation sorts
  "balance",
  "totalDeposited",
  "totalWagered",
  // raw-SQL computed sorts
  "pnl",
  "totalWithdrawn",
  "netHoldings",
  "depositCount",
]);
export type UsersSortBy = z.infer<typeof UsersSortBy>;

/**
 * Status filter values surfaced in the toolbar. `getUsers` only acts on
 * these three strings (anything else is treated as "no status filter"),
 * so the schema mirrors that: an unknown status is dropped rather than
 * passed through.
 */
export const UsersStatusFilter = z.enum(["active", "banned", "locked"]);
export type UsersStatusFilter = z.infer<typeof UsersStatusFilter>;


/**
 * Role filter values surfaced in the toolbar. These map onto the game
 * DB's `user_role` enum members the list filters by. `getUsers` already
 * validates the role against the generated `user_role` enum before it
 * touches the where / raw-SQL branch (unknown → ignored), so this is a
 * second gate at the page boundary; an unknown role is dropped here too.
 */
export const UsersRoleFilter = z.enum([
  "admin",
  "support",
  "creator",
  "user",
]);
export type UsersRoleFilter = z.infer<typeof UsersRoleFilter>;

/**
 * Free-form search match mode (URL param `match`).
 *
 *   "prefix"   (default) → left-anchored `ILIKE 'term%'`, index-backed by
 *                          the recommended lower(col) text_pattern_ops
 *                          indexes. Fast; the common typed-handle case.
 *   "contains"           → legacy leading-wildcard `%term%` interior
 *                          match. Slower (full scan until the pg_trgm GIN
 *                          index lands), so it is opt-in only.
 *
 * Maps onto getUsers' `searchMode` ("prefix" | "substring"). Only affects
 * the free-form handle/name branch — user id / email / discord-id searches
 * always take their exact-match fast path regardless. An unknown value
 * falls back to "prefix".
 */
export const UsersMatchMode = z.enum(["prefix", "contains"]);
export type UsersMatchMode = z.infer<typeof UsersMatchMode>;

/**
 * `perPage` upper bound. The pagination control offers up to 200 rows
 * (see DataTablePagination's [10, 20, 50, 100, 200] options), so the cap
 * must allow 200 — clamping lower would silently break the legit
 * "200 rows" choice. The min of 1 + integer coercion stops the negative
 * / fractional / 10-billion-row values that crashed or hung the query.
 */
const PER_PAGE_MAX = 200;

/**
 * `page` upper bound. `z.coerce.number().int().min(1)` alone still admits
 * `?page=1e10` (10,000,000,000 IS a positive integer) — which becomes a
 * 10-billion-row `OFFSET`, a pathological sequential scan that hangs the
 * query. The real user base is a few million rows at most, so even at the
 * 200-row max page size the last real page is in the low tens of
 * thousands; 100k is a generous ceiling that's far beyond any genuine
 * navigation yet blocks the absurd offsets a URL-fuzzer would inject. A
 * page past the end of the data just renders an empty slice (the
 * pagination control already clamps Next/Prev against `totalPages`).
 */
const PAGE_MAX = 100_000;

const UsersSearchParamsSchema = z.object({
  // `z.coerce.number().int().min(1).max(PAGE_MAX)` rejects negatives,
  // zero, NaN (non-numeric strings), fractions, and the 10-billion-row
  // offsets — `.catch(1)` snaps any of them back to page 1 WITHOUT
  // discarding the other (valid) params on the URL.
  page: z.coerce.number().int().min(1).max(PAGE_MAX).default(1).catch(1),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(PER_PAGE_MAX)
    .default(20)
    .catch(20),
  // Free-form search text — bounded so an absurdly long paste can't be
  // shovelled into the ILIKE. The query trims + shape-routes it (UUID /
  // email / discord-id fast paths) on its own.
  search: z.string().trim().max(200).optional(),
  // Match mode for the free-form search branch. Defaults to the fast,
  // index-backed prefix match; `?match=contains` opts into the slower
  // interior-substring match. `.catch("prefix")` keeps a fuzzed value
  // from forcing the slow path.
  match: UsersMatchMode.default("prefix").catch("prefix"),
  // No `codeSearch` flag — the old "Affiliate code only" checkbox and its
  // `?codeSearch=1` param are gone (owner, 2026-07-23). Code-only search now
  // rides on the TERM instead: `?search=c:packygg` returns the owners of
  // codes matching "packygg" and nothing else (see parseSearchTerm in
  // users-list.ts). That keeps the mode inside the value `search` already
  // validates here — bounded to 200 chars, trimmed — with no second param to
  // keep in sync, and it survives a copy-pasted URL.
  // `.catch(undefined)` on every filter / sort field so a single bad
  // value (e.g. ?role=bogus) drops ONLY that filter instead of failing
  // the whole parse and resetting every other valid param to its default.
  role: UsersRoleFilter.optional().catch(undefined),
  status: UsersStatusFilter.optional().catch(undefined),
  // Referral filter — restricts the list to users referred via THIS
  // specific affiliate/creator code (matched against
  // `affiliate_code_usages.code`, the same authoritative join
  // getCodeReferrals / getCodeAnalytics in src/lib/queries/creators-codes.ts
  // already use to answer "who did this code refer"). Set by the "View
  // referrals" link on a user's owned-code row
  // (users/[id]/user-view-modern-tabs.tsx OwnedCodeRow) via
  // `/users?affiliateCode=<code>`. Same bound + trim as `search` above;
  // case-insensitivity is handled query-side (UPPER(code) comparison).
  affiliateCode: z.string().trim().max(200).optional(),
  // Referral filter (all codes) — restricts the list to every user this
  // OWNER (any of their codes) has ever referred, matched against
  // `affiliate_code_usages.affiliate_user_id` (no code restriction, so it
  // covers every code the owner has ever had, past or present). Sibling to
  // `affiliateCode` above (per-code); the two are alternatives — only one
  // applies at a time (see buildUserListWhereClause in
  // src/lib/queries/users-list.ts). Set by the "View all referrals" link
  // on the owned-codes card header (users/[id]/user-view-modern-tabs.tsx
  // OwnCodeCard) via `/users?affiliateOwnerId=<owner user id>`. Same bound
  // + trim as affiliateCode; this is a packy.gg user id, not a code
  // string, so no case-folding is needed query-side.
  affiliateOwnerId: z.string().trim().max(200).optional(),
  // No `.default()` on the sort pair: when the URL carries no sort the
  // query applies its OWN default (created_at desc), so leaving these
  // undefined preserves the existing happy-path ordering exactly. A
  // PRESENT-but-invalid value (e.g. ?sortBy=DROP) is the thing we must
  // not forward — `.catch(undefined)` turns that into "no sort" so it
  // falls through to the query default instead of reaching the SQL.
  sortBy: UsersSortBy.optional().catch(undefined),
  sortOrder: UsersSortOrder.optional().catch(undefined),
});

export type UsersSearchParams = z.infer<typeof UsersSearchParamsSchema>;

/**
 * Parse the raw search params from the /users page into a typed,
 * defaulted, SQL-safe object. Invalid values silently fall back to
 * defaults (or are dropped) so a bad URL never breaks the page render —
 * we only forward values we know `getUsers` can safely consume.
 */
export function parseUsersSearchParams(
  raw: Record<string, string | undefined>,
): UsersSearchParams {
  const parsed = UsersSearchParamsSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : UsersSearchParamsSchema.parse({});
}
