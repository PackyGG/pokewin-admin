import { adminDb } from "@/lib/admin-db";
import { db } from "@/lib/db";

export async function getNotesForUser(targetUserId: string) {
  const notes = await adminDb.admin_notes.findMany({
    where: { target_user_id: targetUserId },
    orderBy: { created_at: "desc" },
    include: {
      admin_user: { select: { username: true } },
    },
  });

  return notes.map((n) => ({
    id: n.id,
    adminUserId: n.admin_user_id,
    adminUsername: n.admin_user.username,
    content: n.content,
    createdAt: n.created_at.toISOString(),
    updatedAt: n.updated_at.toISOString(),
  }));
}

export type AdminNote = Awaited<ReturnType<typeof getNotesForUser>>[number];

export async function getNotesFromAdmin(adminUserId: string) {
  const notes = await adminDb.admin_notes.findMany({
    where: { admin_user_id: adminUserId },
    orderBy: { created_at: "desc" },
  });

  // Resolve target usernames from main DB
  const targetUserIds = [...new Set(notes.map((n) => n.target_user_id))];
  const usernameMap = new Map<string, string>();
  if (targetUserIds.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: targetUserIds } },
      select: { id: true, username: true, email: true },
    });
    for (const u of users) {
      usernameMap.set(u.id, u.username ?? u.email ?? u.id);
    }
  }

  return notes.map((n) => ({
    id: n.id,
    targetUserId: n.target_user_id,
    targetUsername: usernameMap.get(n.target_user_id) ?? null,
    content: n.content,
    createdAt: n.created_at.toISOString(),
    updatedAt: n.updated_at.toISOString(),
  }));
}
