import { adminDb } from "@/lib/admin-db";

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
