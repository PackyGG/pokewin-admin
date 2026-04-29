"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function createNote(targetUserId: string, content: string) {
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_create_user_note", "create notes");

  if (!content.trim()) {
    throw new Error("Note content cannot be empty");
  }

  await adminDb.admin_notes.create({
    data: {
      admin_user_id: session.userId,
      target_user_id: targetUserId,
      content: content.trim(),
    },
  });

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

  const note = await adminDb.admin_notes.findUnique({
    where: { id: noteId },
  });

  if (!note) throw new Error("Note not found");

  await adminDb.admin_notes.delete({ where: { id: noteId } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_note_deleted",
    targetUserId: note.target_user_id,
    metadata: { note_id: noteId },
  });

  revalidatePath(`/users/${note.target_user_id}`);
}
