import { db } from "@/lib/db";
import type { PaginatedResult } from "@/lib/types";

export type ChatMessageItem = {
  id: string;
  userId: string;
  username: string | null;
  image: string | null;
  level: number;
  role: string;
  content: string;
  isDeleted: boolean;
  isPinned: boolean;
  activeMuteId: string | null;
  createdAt: string;
};

export type MuteItem = {
  id: string;
  userId: string;
  username: string | null;
  mutedByUsername: string | null;
  reason: string | null;
  expiresAt: string | null;
  unmutedAt: string | null;
  createdAt: string;
};

export async function getChatMessages(params: {
  page?: number;
  perPage?: number;
  search?: string;
}): Promise<PaginatedResult<ChatMessageItem>> {
  const { page = 1, perPage = 20, search } = params;

  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { content: { contains: search, mode: "insensitive" } },
      { user_chat_messages_user_idTouser: { username: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [messages, total] = await Promise.all([
    db.chat_messages.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
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
    }),
    db.chat_messages.count({ where }),
  ]);

  // Batch-check active mutes for all users in this page
  const userIds = [...new Set(messages.map((m) => m.user_id))];
  const activeMutes = userIds.length > 0
    ? await db.user_mutes.findMany({
        where: {
          user_id: { in: userIds },
          unmuted_at: null,
          OR: [
            { expires_at: null },
            { expires_at: { gt: new Date() } },
          ],
        },
        select: { id: true, user_id: true },
      })
    : [];
  const muteByUser = new Map(activeMutes.map((m) => [m.user_id, m.id]));

  return {
    data: messages.map((m) => ({
      id: m.id,
      userId: m.user_id,
      username: m.user_chat_messages_user_idTouser?.username ?? null,
      image: m.user_chat_messages_user_idTouser?.image ?? null,
      level: m.user_chat_messages_user_idTouser?.user_statistics?.level ?? 0,
      role: m.user_chat_messages_user_idTouser?.role ?? "user",
      content: m.content,
      isDeleted: m.is_deleted,
      isPinned: !!m.pinned_chat_messages,
      activeMuteId: muteByUser.get(m.user_id) ?? null,
      createdAt: m.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

/**
 * Chat messages created strictly AFTER `sinceIso`, in chronological order.
 *
 * Used by the SSE live-feed route in `src/app/api/live/chat/route.ts` to
 * emit only new rows since the last tick. Ordered ascending so the stream
 * delivers messages oldest-first — matches how the panel appends them to
 * the bottom of the scroll view.
 *
 * No `activeMuteId` is included (kept null) because the mute state is UI
 * decoration and the initial /chat fetch provides the authoritative mute
 * list for the page.
 */
export async function getChatMessagesSince(
  sinceIso: string,
  limit = 100,
): Promise<ChatMessageItem[]> {
  const since = new Date(sinceIso);
  const rows = await db.chat_messages.findMany({
    where: { created_at: { gt: since } },
    orderBy: { created_at: "asc" },
    take: Math.max(1, Math.min(200, Math.floor(limit))),
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
    activeMuteId: null,
    createdAt: m.created_at.toISOString(),
  }));
}

export async function getMutes(params: {
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<MuteItem>> {
  const { page = 1, perPage = 20 } = params;

  const [mutes, total] = await Promise.all([
    db.user_mutes.findMany({
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user_user_mutes_user_idTouser: { select: { username: true } },
        user_user_mutes_muted_byTouser: { select: { username: true } },
      },
    }),
    db.user_mutes.count(),
  ]);

  return {
    data: mutes.map((m) => ({
      id: m.id,
      userId: m.user_id,
      username: m.user_user_mutes_user_idTouser?.username ?? null,
      mutedByUsername: m.user_user_mutes_muted_byTouser?.username ?? null,
      reason: m.reason,
      expiresAt: m.expires_at?.toISOString() ?? null,
      unmutedAt: m.unmuted_at?.toISOString() ?? null,
      createdAt: m.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
