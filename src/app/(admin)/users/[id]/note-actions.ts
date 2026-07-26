"use server";

import { revalidatePath } from "next/cache";
import { adminDrizzle, sql } from "@/lib/drizzle";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function createNote(targetUserId: string, content: string) {
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_create_user_note", "create notes");

  if (!content.trim()) {
    throw new Error("Note content cannot be empty");
  }

  await adminDrizzle.execute(sql`
    INSERT INTO admin_notes (admin_user_id, target_user_id, content)
    VALUES (${session.userId}::uuid, ${targetUserId}, ${content.trim()})
  `);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_note_created",
    targetUserId,
    metadata: { content_preview: content.trim().slice(0, 100) },
  });

  revalidatePath(`/users/${targetUserId}`);
}

export async function deleteNote(noteId: string) {
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_delete_user_note", "delete notes");

  const note = (
    await adminDrizzle.execute<{ target_user_id: string }>(sql`
      DELETE FROM admin_notes
      WHERE id = ${noteId}::uuid
      RETURNING target_user_id
    `)
  ).rows[0];
  if (!note) throw new Error("Note not found");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_note_deleted",
    targetUserId: note.target_user_id,
    metadata: { note_id: noteId },
  });

  revalidatePath(`/users/${note.target_user_id}`);
}
