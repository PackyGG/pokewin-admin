import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";

export async function getNotesForUser(targetUserId: string) {
  const notes = await adminDrizzle.execute<{
    id: string;
    admin_user_id: string;
    admin_username: string;
    content: string;
    created_at: Date;
    updated_at: Date;
  }>(sql`
    SELECT n.id, n.admin_user_id, u.username AS admin_username,
           n.content, n.created_at, n.updated_at
    FROM admin_notes n
    INNER JOIN admin_users u ON u.id = n.admin_user_id
    WHERE n.target_user_id = ${targetUserId}
    ORDER BY n.created_at DESC
  `);

  return notes.rows.map((n) => ({
    id: n.id,
    adminUserId: n.admin_user_id,
    adminUsername: n.admin_username,
    content: n.content,
    createdAt: n.created_at.toISOString(),
    updatedAt: n.updated_at.toISOString(),
  }));
}
