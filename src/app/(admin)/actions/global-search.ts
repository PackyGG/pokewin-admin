"use server";

// Global user search used by the command palette (CMD+K) and the optional
// "Go to user…" quick action. Runs against the MAIN DB (db.user), not the
// admin DB — this is the live end-user table.
//
// Rules:
//   - Any logged-in admin session may search (palette is admin-only UI).
//   - Matches on username (contains, ILIKE), email (contains, ILIKE), or
//     exact UUID id. Short queries (< 2 chars) and non-string inputs return
//     an empty array so we don't ship the entire table on an empty debounce.
//   - Support users don't need to see fellow staff — we exclude admin /
//     creator accounts when the searcher is `support`. Admins see all.
//   - Cap the result set at 8 rows. The palette shows them inline.
//   - No cross-DB joins. Only user columns are returned.
//
// PII handling (M1 — security audit):
//   The result shape is intentionally minimal. We only ever expose
//   non-sensitive identity fields by default (id, username, displayUsername,
//   role, image, isBanned, isLocked). Email is sensitive PII and is gated:
//     - role === "admin"  → full email
//     - any other role    → masked (e.g. `j***@example.com`)
//   We never select signup_ip, country/city, fingerprints, or any other
//   identifying columns from the user table.

import { getDb } from "@/lib/db";
import { verifySession } from "@/lib/dal";
import { canCurrentAdminIncludeExcludedInSearch } from "@/lib/excluded-users/search-gate";
import { getExcludedUserIdsForAdminSearch } from "@/lib/excluded-users/search-visible-override";

export type GlobalUserSearchResult = {
  id: string;
  username: string | null;
  displayUsername: string | null;
  /**
   * Either the full email (full admins) or a masked form like
   * `j***@example.com` for other roles. Never raw email for non-admins.
   * Null when the user has no email on record.
   */
  email: string | null;
  image: string | null;
  role: string;
  isBanned: boolean;
  isLocked: boolean;
};

const MAX_RESULTS = 8;
const MIN_QUERY_LENGTH = 2;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mask the local part of an email so non-admin staff can still tell users
 * apart visually without seeing the full address. Keeps the first character
 * + the domain, replaces the rest with three asterisks.
 *   "jane.doe@example.com" → "j***@example.com"
 *   "x@example.com"        → "x***@example.com"
 *   "noatsign"             → "***" (defensive — should never happen in DB)
 */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.charAt(0)}***${domain}`;
}

type RawUserRow = {
  id: string;
  username: string | null;
  display_username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  is_banned: boolean;
  is_locked: boolean;
};

function projectRow(
  row: RawUserRow,
  canSeeFullEmail: boolean,
): GlobalUserSearchResult {
  let email: string | null = null;
  if (row.email) {
    email = canSeeFullEmail ? row.email : maskEmail(row.email);
  }
  return {
    id: row.id,
    username: row.username,
    displayUsername: row.display_username,
    email,
    image: row.image,
    role: row.role,
    isBanned: row.is_banned,
    isLocked: row.is_locked,
  };
}

export async function searchUsersGlobal(
  query: string,
): Promise<GlobalUserSearchResult[]> {
  const db = await getDb();
  const session = await verifySession();

  // Only full admins see the raw email. Every other role (support,
  // marketing, creator) gets a masked form. This is the explicit gate
  // referenced in the M1 audit item.
  const canSeeFullEmail = session.role === "admin";
  const includeExcluded = await canCurrentAdminIncludeExcludedInSearch(
    session.userId,
  );
  // Single source of truth for search exclusion (shared with the /users list).
  // Owners (includeExcluded) still see ordinary blacklisted users, but the
  // ALWAYS_HIDDEN_FROM_SEARCH hard-hide tier is withheld from EVERYONE — so a
  // user the owner has declared invisible ("nobody, not motha not kotha") can't
  // be found here either, by username, email, or exact id.
  const excludedUserIds = await getExcludedUserIdsForAdminSearch({
    includeAllBlacklisted: includeExcluded,
    isSearching: true,
  });
  const excludedFilter =
    excludedUserIds.length > 0 ? { id: { notIn: excludedUserIds } } : {};

  // Normalize & validate the query client-side is untrusted.
  const raw = typeof query === "string" ? query.trim() : "";
  // Allow leading `@` as a user-search prefix that the palette strips.
  const cleaned = raw.startsWith("@") ? raw.slice(1).trim() : raw;
  if (cleaned.length < MIN_QUERY_LENGTH) return [];

  // Exact UUID lookup — cheapest match, always wins.
  if (UUID_REGEX.test(cleaned)) {
    if (
      excludedUserIds.length > 0 &&
      excludedUserIds.includes(cleaned)
    ) {
      return [];
    }
    const user = await db.user.findUnique({
      where: { id: cleaned },
      select: {
        id: true,
        username: true,
        display_username: true,
        email: true,
        image: true,
        role: true,
        is_banned: true,
        is_locked: true,
      },
    });
    return user ? [projectRow(user, canSeeFullEmail)] : [];
  }

  // Support users shouldn't be able to pull up other staff through the
  // palette. Admins can see everything (this matches the existing
  // EXCLUDE_STAFF behaviour in analytics queries).
  const excludeStaff = session.role === "support";

  const users = await db.user.findMany({
    where: {
      ...excludedFilter,
      OR: [
        { username: { contains: cleaned, mode: "insensitive" } },
        { email: { contains: cleaned, mode: "insensitive" } },
      ],
      ...(excludeStaff
        ? { role: { notIn: ["admin", "creator"] as const } }
        : {}),
    },
    orderBy: [
      // Exact username match first, then prefix, then the rest.
      { username: "asc" },
    ],
    take: MAX_RESULTS,
    select: {
      id: true,
      username: true,
      display_username: true,
      email: true,
      image: true,
      role: true,
      is_banned: true,
      is_locked: true,
    },
  });

  return users.map((u) => projectRow(u, canSeeFullEmail));
}
