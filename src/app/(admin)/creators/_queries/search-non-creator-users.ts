"use server";

import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";

export type NonCreatorCandidate = {
  userId: string;
  username: string | null;
  email: string | null;
  role: string;
};

/**
 * Pragmatic local Prisma query: find up to 8 users (NOT creators) whose
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

  const db = await getDb();
  const users = await db.user.findMany({
    where: {
      role: { not: "creator" },
      OR: [
        { username: { contains: trimmed, mode: "insensitive" } },
        { email: { contains: trimmed, mode: "insensitive" } },
      ],
    },
    select: { id: true, username: true, email: true, role: true },
    take: 8,
    orderBy: { created_at: "desc" },
  });

  return users.map((u) => ({
    userId: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
  }));
}
