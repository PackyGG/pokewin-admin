"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getChatMessages,
  getMutes,
  type ChatMessageItem,
  type MuteItem,
} from "@/lib/queries/chat";
import type { PaginatedResult } from "@/lib/types";

/**
 * Resolve a Main-DB `User.id` for the calling admin so it can be written
 * into FK columns that reference the Main-DB `User` table (e.g.
 * `user_mutes.muted_by`, `user_mutes.unmuted_by`).
 *
 * Background: admin identities live in the Admin DB (`admin_users`),
 * which is a separate database from the Main DB (`User`). The mute/pin
 * tables in Main DB carry a NOT-NULL FK to `User.id`, so a raw
 * `session.userId` would either fail with a FK violation (no matching
 * row) or — worse — accidentally reference whichever Main-DB user
 * happens to share that UUID.
 *
 * Linking is by email: `admin_users.email` is kept in sync with the
 * Main-DB `User.email` for creator-role admins (see
 * `linkCreatorToMainUser`). For non-linked admins this returns null
 * and the caller must fall back. The authoritative attribution is
 * always the admin audit event written via `createAdminAuditEvent`.
 */
async function resolveAdminMainUserId(
  adminUserId: string,
): Promise<string | null> {
  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { email: true },
  });
  if (!adminUser?.email) return null;

  const db = await getDb();
  const mainUser = await db.user.findUnique({
    where: { email: adminUser.email },
    select: { id: true },
  });
  return mainUser?.id ?? null;
}

export async function fetchChatMessagesPanel(params: {
  page?: number;
  perPage?: number;
  search?: string;
}): Promise<PaginatedResult<ChatMessageItem>> {
  await requirePageAccess("/chat");
  return getChatMessages(params);
}

export async function fetchMutesPanel(params: {
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<MuteItem>> {
  await requirePageAccess("/chat");
  return getMutes(params);
}

export async function deleteMessage(messageId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_delete_messages", "delete chat messages");

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
  const db = await getDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_pin_messages", "pin messages");

  const message = await db.chat_messages.findUnique({
    where: { id: messageId },
    select: { user_id: true },
  });
  if (!message) {
    throw new Error("Message not found");
  }

  // `pinned_chat_messages.pinned_by` is a NOT-NULL FK to Main-DB
  // `User.id`. Same dual-DB constraint as `user_mutes.muted_by`:
  // resolve to the admin's linked main-user id when available;
  // otherwise fall back to the message author so the FK is satisfied.
  // Authoritative admin attribution lives in the audit event.
  const issuerMainUserId =
    (await resolveAdminMainUserId(session.userId)) ?? message.user_id;

  await db.pinned_chat_messages.create({
    data: {
      id: randomUUID(),
      message_id: messageId,
      pinned_by: issuerMainUserId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_message_pinned",
    targetUserId: message.user_id,
    metadata: { message_id: messageId, issuer_main_user_id: issuerMainUserId },
  });

  revalidatePath("/chat");
}

export async function unpinMessage(messageId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_pin_messages", "unpin messages");

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
  const db = await getDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_mute_users", "mute users");

  // `user_mutes.muted_by` is a NOT-NULL FK to Main-DB `User.id`.
  // Admin identities live in the Admin DB and have no corresponding
  // Main-DB row unless the admin is a creator with a linked main user
  // (see `resolveAdminMainUserId`). Prefer the linked main-user id so
  // the FK reflects the actual issuer; fall back to the target user
  // for unlinked admins (existing behavior — schema doesn't allow
  // null here). The authoritative admin attribution is the audit
  // event written below regardless of which path is taken.
  const issuerMainUserId =
    (await resolveAdminMainUserId(session.userId)) ?? data.userId;

  await db.user_mutes.create({
    data: {
      id: randomUUID(),
      user_id: data.userId,
      muted_by: issuerMainUserId,
      reason: data.reason || null,
      expires_at: data.expiresAt ? new Date(data.expiresAt) : null,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_muted",
    targetUserId: data.userId,
    metadata: {
      reason: data.reason,
      expires_at: data.expiresAt,
      issuer_main_user_id: issuerMainUserId,
    },
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
  const db = await getDb();
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
  const db = await getDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_mute_users", "unmute users");

  const mute = await db.user_mutes.findUnique({
    where: { id: muteId },
    select: { user_id: true },
  });
  if (!mute) throw new Error("Mute not found");

  // `user_mutes.unmuted_by` is a NULLABLE FK to Main-DB `User.id`.
  // Mirror the `muteUser` resolution: write the admin's linked main-user
  // id when available, otherwise leave it null. Audit event is the
  // source of truth for the admin identity.
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);

  await db.user_mutes.update({
    where: { id: muteId },
    data: {
      unmuted_at: new Date(),
      unmuted_by: issuerMainUserId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_unmuted",
    targetUserId: mute.user_id,
    metadata: { mute_id: muteId, issuer_main_user_id: issuerMainUserId },
  });

  revalidatePath("/chat");
}
