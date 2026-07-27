"use server";

import { and, desc, ilike, ne, or } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { user } from "@/lib/db-schema/main/schema";
import { requirePageAccess } from "@/lib/dal";

export type NonCreatorCandidate = {
  userId: string;
  username: string | null;
  email: string | null;
  role: string;
};

/**
 * Pragmatic local Drizzle query: find up to 8 users (NOT creators) whose
 * username or email matches `search`. Used by the "Add Creator" dialog so
 * the admin can pick a candidate and promote them.
 *
 * Backend has no dedicated user-search endpoint yet; since this is a read
 * against the main DB (which admin already reads from for other panels),
 * doing it locally is cheaper than a round-trip and keeps the dialog UX
 * responsive. If search is too short, returns an empty list.
 */
export async function searchNonCreatorUsers(
  search: string,
): Promise<NonCreatorCandidate[]> {
  await requirePageAccess("/creators");

  const trimmed = search.trim();
  if (trimmed.length < 2) return [];

  const db = await getReadDrizzleDb();
  const users = await db
    .select({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    })
    .from(user)
    .where(
      and(
        ne(user.role, "creator"),
        or(
          ilike(user.username, `%${trimmed}%`),
          ilike(user.email, `%${trimmed}%`),
        ),
      ),
    )
    .orderBy(desc(user.created_at))
    .limit(8);

  return users.map((u) => ({
    userId: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
  }));
}
