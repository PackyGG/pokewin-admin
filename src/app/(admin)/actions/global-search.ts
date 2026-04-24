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

import { getDb } from "@/lib/db";
import { verifySession } from "@/lib/dal";

export type GlobalUserSearchResult = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
};

const MAX_RESULTS = 8;
const MIN_QUERY_LENGTH = 2;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function searchUsersGlobal(
  query: string,
): Promise<GlobalUserSearchResult[]> {
  const db = await getDb();
  const session = await verifySession();

  // Normalize & validate the query client-side is untrusted.
  const raw = typeof query === "string" ? query.trim() : "";
  // Allow leading `@` as a user-search prefix that the palette strips.
  const cleaned = raw.startsWith("@") ? raw.slice(1).trim() : raw;
  if (cleaned.length < MIN_QUERY_LENGTH) return [];

  // Exact UUID lookup — cheapest match, always wins.
  if (UUID_REGEX.test(cleaned)) {
    const user = await db.user.findUnique({
      where: { id: cleaned },
      select: {
        id: true,
        username: true,
        email: true,
        image: true,
        role: true,
      },
    });
    return user ? [user] : [];
  }

  // Support users shouldn't be able to pull up other staff through the
  // palette. Admins can see everything (this matches the existing
  // EXCLUDE_STAFF behaviour in analytics queries).
  const excludeStaff = session.role === "support";

  const users = await db.user.findMany({
    where: {
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
      email: true,
      image: true,
      role: true,
    },
  });

  return users;
}
