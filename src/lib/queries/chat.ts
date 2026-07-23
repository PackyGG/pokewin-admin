import { getDb } from "@/lib/db";
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
  const db = await getDb();
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

export async function getMutes(params: {
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<MuteItem>> {
  const db = await getDb();
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

// NOTE — the former `getTopChattersToday` aggregate lived here and backed the
// read-only /top-chatters leaderboard. That page became /chat-raffle, whose
// scorer (src/lib/chat-raffle/standings.ts) supersedes it: same window scan
// over `chat_messages` on the same partial index, but weighted, rate-capped
// and eligibility-filtered. The naive-timestamp convention and the
// index-safety notes moved there with it.
