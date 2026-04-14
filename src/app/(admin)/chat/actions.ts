"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function deleteMessage(messageId: string) {
  const session = await requirePageAccess("/chat");

  const message = await db.chat_messages.findUnique({
    where: { id: messageId },
    select: { user_id: true },
  });
  if (!message) {
    throw new Error("Message not found");
  }

  await db.chat_messages.update({
    where: { id: messageId },
    data: {
      is_deleted: true,
      deleted_at: new Date(),
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_message_deleted",
    targetUserId: message.user_id,
    metadata: { message_id: messageId },
  });

  revalidatePath("/chat");
}

export async function pinMessage(messageId: string) {
  const session = await requirePageAccess("/chat");

  const message = await db.chat_messages.findUnique({
    where: { id: messageId },
    select: { user_id: true },
  });
  if (!message) {
    throw new Error("Message not found");
  }

  await db.pinned_chat_messages.create({
    data: {
      id: randomUUID(),
      message_id: messageId,
      pinned_by: session.userId,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_message_pinned",
    targetUserId: message.user_id,
    metadata: { message_id: messageId },
  });

  revalidatePath("/chat");
}

export async function unpinMessage(messageId: string) {
  const session = await requirePageAccess("/chat");

  const pinned = await db.pinned_chat_messages.findUnique({
    where: { message_id: messageId },
    select: { chat_messages: { select: { user_id: true } } },
  });
  if (!pinned) {
    throw new Error("Pinned message not found");
  }

  await db.pinned_chat_messages.delete({
    where: { message_id: messageId },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_message_unpinned",
    targetUserId: pinned.chat_messages?.user_id,
    metadata: { message_id: messageId },
  });

  revalidatePath("/chat");
}

export async function muteUser(data: {
  userId: string;
  reason: string;
  expiresAt: string | null;
}) {
  const session = await requirePageAccess("/chat");

  // muted_by FK requires a valid User ID — use the target user since admin is in a separate table
  // The actual admin identity is tracked in the audit event below
  await db.user_mutes.create({
    data: {
      id: randomUUID(),
      user_id: data.userId,
      muted_by: data.userId,
      reason: data.reason || null,
      expires_at: data.expiresAt ? new Date(data.expiresAt) : null,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_muted",
    targetUserId: data.userId,
    metadata: { reason: data.reason, expires_at: data.expiresAt },
  });

  revalidatePath("/chat");
}

export async function pollMessages(sinceIso: string): Promise<{
  id: string;
  userId: string;
  username: string | null;
  image: string | null;
  level: number;
  role: string;
  content: string;
  isDeleted: boolean;
  isPinned: boolean;
  createdAt: string;
}[]> {
  await requirePageAccess("/chat");
  const since = new Date(sinceIso);
  const rows = await db.chat_messages.findMany({
    where: { created_at: { gt: since } },
    orderBy: { created_at: "asc" },
    take: 100,
    include: {
      user_chat_messages_user_idTouser: {
        select: {
          username: true,
          image: true,
          role: true,
          user_statistics: { select: { level: true } },
        },
      },
      pinned_chat_messages: { select: { id: true } },
    },
  });
  return rows.map((m) => ({
    id: m.id,
    userId: m.user_id,
    username: m.user_chat_messages_user_idTouser?.username ?? null,
    image: m.user_chat_messages_user_idTouser?.image ?? null,
    level: m.user_chat_messages_user_idTouser?.user_statistics?.level ?? 0,
    role: m.user_chat_messages_user_idTouser?.role ?? "user",
    content: m.content,
    isDeleted: m.is_deleted,
    isPinned: !!m.pinned_chat_messages,
    createdAt: m.created_at.toISOString(),
  }));
}

export async function unmuteUser(muteId: string) {
  const session = await requirePageAccess("/chat");

  const mute = await db.user_mutes.findUnique({ where: { id: muteId } });
  if (!mute) throw new Error("Mute not found");

  await db.user_mutes.update({
    where: { id: muteId },
    data: {
      unmuted_at: new Date(),
      unmuted_by: null,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_unmuted",
    targetUserId: mute.user_id,
    metadata: { mute_id: muteId },
  });

  revalidatePath("/chat");
}
