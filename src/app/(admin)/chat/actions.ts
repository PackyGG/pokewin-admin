"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { asc, eq, gt } from "drizzle-orm";
import { adminDrizzle, getPrimaryDrizzleDb } from "@/lib/drizzle";
import { admin_users } from "@/lib/db-schema/admin/schema";
import {
  chat_messages,
  pinned_chat_messages,
  user,
  user_mutes,
  user_statistics,
} from "@/lib/db-schema/main/schema";
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

const muteUserSchema = z.object({
  userId: z.string().min(1, "User is required"),
  reason: z.string().trim().max(500),
  // ISO-8601 datetime string (e.g. from new Date().toISOString()) or
  // null/undefined for "no expiration". Reject anything else cleanly so
  // bad input doesn't reach `new Date(...)` and produce an Invalid Date.
  expiresAt: z.string().datetime().nullable().optional(),
});

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
  const adminUser = (
    await adminDrizzle
      .select({ email: admin_users.email })
      .from(admin_users)
      .where(eq(admin_users.id, adminUserId))
      .limit(1)
  )[0];
  if (!adminUser?.email) return null;

  const db = await getPrimaryDrizzleDb();
  const [mainUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, adminUser.email))
    .limit(1);
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_delete_messages", "delete chat messages");

  const [message] = await db
    .select({ user_id: chat_messages.user_id })
    .from(chat_messages)
    .where(eq(chat_messages.id, messageId))
    .limit(1);
  if (!message) {
    throw new Error("Message not found");
  }

  await db
    .update(chat_messages)
    .set({
      is_deleted: true,
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where(eq(chat_messages.id, messageId));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_message_deleted",
    targetUserId: message.user_id,
    metadata: { message_id: messageId },
  });

  revalidatePath("/chat");
}

export async function pinMessage(messageId: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_pin_messages", "pin messages");

  const [message] = await db
    .select({ user_id: chat_messages.user_id })
    .from(chat_messages)
    .where(eq(chat_messages.id, messageId))
    .limit(1);
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

  await db.insert(pinned_chat_messages).values({
      id: randomUUID(),
      message_id: messageId,
      pinned_by: issuerMainUserId,
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_pin_messages", "unpin messages");

  const [pinned] = await db
    .select({ user_id: chat_messages.user_id })
    .from(pinned_chat_messages)
    .innerJoin(
      chat_messages,
      eq(chat_messages.id, pinned_chat_messages.message_id),
    )
    .where(eq(pinned_chat_messages.message_id, messageId))
    .limit(1);
  if (!pinned) {
    throw new Error("Pinned message not found");
  }

  await db
    .delete(pinned_chat_messages)
    .where(eq(pinned_chat_messages.message_id, messageId));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_message_unpinned",
    targetUserId: pinned.user_id,
    metadata: { message_id: messageId },
  });

  revalidatePath("/chat");
}

export async function muteUser(data: z.infer<typeof muteUserSchema>) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_mute_users", "mute users");

  const parsed = muteUserSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid mute input");
  }
  const v = parsed.data;

  // `user_mutes.muted_by` is a NOT-NULL FK to Main-DB `User.id`.
  // Admin identities live in the Admin DB and have no corresponding
  // Main-DB row unless the admin is a creator with a linked main user
  // (see `resolveAdminMainUserId`). Prefer the linked main-user id so
  // the FK reflects the actual issuer; fall back to the target user
  // for unlinked admins (existing behavior — schema doesn't allow
  // null here). The authoritative admin attribution is the audit
  // event written below regardless of which path is taken.
  const issuerMainUserId =
    (await resolveAdminMainUserId(session.userId)) ?? v.userId;

  await db.insert(user_mutes).values({
      id: randomUUID(),
      user_id: v.userId,
      muted_by: issuerMainUserId,
      reason: v.reason || null,
      expires_at: v.expiresAt ? new Date(v.expiresAt).toISOString() : null,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_muted",
    targetUserId: v.userId,
    metadata: {
      reason: v.reason,
      expires_at: v.expiresAt,
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
  const db = await getPrimaryDrizzleDb();
  await requirePageAccess("/chat");
  const since = new Date(sinceIso);
  const rows = await db
    .select({
      id: chat_messages.id,
      user_id: chat_messages.user_id,
      content: chat_messages.content,
      is_deleted: chat_messages.is_deleted,
      created_at: chat_messages.created_at,
      username: user.username,
      image: user.image,
      role: user.role,
      level: user_statistics.level,
      pinned_id: pinned_chat_messages.id,
    })
    .from(chat_messages)
    .leftJoin(user, eq(user.id, chat_messages.user_id))
    .leftJoin(user_statistics, eq(user_statistics.user_id, user.id))
    .leftJoin(
      pinned_chat_messages,
      eq(pinned_chat_messages.message_id, chat_messages.id),
    )
    .where(gt(chat_messages.created_at, since.toISOString()))
    .orderBy(asc(chat_messages.created_at))
    .limit(100);
  return rows.map((m) => ({
    id: m.id,
    userId: m.user_id,
    username: m.username ?? null,
    image: m.image ?? null,
    level: m.level ?? 0,
    role: m.role ?? "user",
    content: m.content,
    isDeleted: m.is_deleted,
    isPinned: !!m.pinned_id,
    createdAt: new Date(m.created_at).toISOString(),
  }));
}

export async function unmuteUser(muteId: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/chat");
  await requireCapability(session, "__can_mute_users", "unmute users");

  const [mute] = await db
    .select({ user_id: user_mutes.user_id })
    .from(user_mutes)
    .where(eq(user_mutes.id, muteId))
    .limit(1);
  if (!mute) throw new Error("Mute not found");

  // `user_mutes.unmuted_by` is a NULLABLE FK to Main-DB `User.id`.
  // Mirror the `muteUser` resolution: write the admin's linked main-user
  // id when available, otherwise leave it null. Audit event is the
  // source of truth for the admin identity.
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);

  await db
    .update(user_mutes)
    .set({
      unmuted_at: new Date().toISOString(),
      unmuted_by: issuerMainUserId,
      updated_at: new Date().toISOString(),
    })
    .where(eq(user_mutes.id, muteId));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_unmuted",
    targetUserId: mute.user_id,
    metadata: { mute_id: muteId, issuer_main_user_id: issuerMainUserId },
  });

  revalidatePath("/chat");
}
