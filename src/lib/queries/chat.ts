import { sql } from "drizzle-orm";
import { getDrizzleDb } from "@/lib/db";
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
  const db = await getDrizzleDb();
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  const perPage = Math.min(
    100,
    Math.max(1, Math.trunc(params.perPage ?? 20) || 20),
  );
  const search = params.search?.trim();
  const searchFilter = search
    ? sql`WHERE (cm.content ILIKE ${`%${search}%`} OR u.username ILIKE ${`%${search}%`})`
    : sql``;
  const [result, countResult] = await Promise.all([db.execute<{
    id: string;
    user_id: string;
    username: string | null;
    image: string | null;
    level: number | null;
    role: string | null;
    content: string;
    is_deleted: boolean;
    is_pinned: boolean;
    active_mute_id: string | null;
    created_at: Date;
  }>(sql`
    SELECT cm.id, cm.user_id, u.username, u.image, us.level, u.role::text AS role,
           cm.content, cm.is_deleted, (pcm.id IS NOT NULL) AS is_pinned,
           mute.id AS active_mute_id, cm.created_at
    FROM chat_messages cm
    LEFT JOIN "user" u ON u.id = cm.user_id
    LEFT JOIN user_statistics us ON us.user_id = cm.user_id
    LEFT JOIN pinned_chat_messages pcm ON pcm.message_id = cm.id
    LEFT JOIN LATERAL (
      SELECT um.id
      FROM user_mutes um
      WHERE um.user_id = cm.user_id
        AND um.unmuted_at IS NULL
        AND (um.expires_at IS NULL OR um.expires_at > NOW())
      ORDER BY um.created_at DESC
      LIMIT 1
    ) mute ON true
    ${searchFilter}
    ORDER BY cm.created_at DESC
    LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `), db.execute<{ total: string }>(sql`
    SELECT COUNT(*)::text AS total
    FROM chat_messages cm
    LEFT JOIN "user" u ON u.id = cm.user_id
    ${searchFilter}
  `)]);
  const messages = result.rows;
  const total = Number(countResult.rows[0]?.total ?? 0);

  return {
    data: messages.map((m) => ({
      id: m.id,
      userId: m.user_id,
      username: m.username,
      image: m.image,
      level: m.level ?? 0,
      role: m.role ?? "user",
      content: m.content,
      isDeleted: m.is_deleted,
      isPinned: m.is_pinned,
      activeMuteId: m.active_mute_id,
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
  const db = await getDrizzleDb();
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  const perPage = Math.min(
    100,
    Math.max(1, Math.trunc(params.perPage ?? 20) || 20),
  );
  const [result, countResult] = await Promise.all([db.execute<{
    id: string;
    user_id: string;
    username: string | null;
    muted_by_username: string | null;
    reason: string | null;
    expires_at: Date | null;
    unmuted_at: Date | null;
    created_at: Date;
  }>(sql`
    SELECT um.id, um.user_id, subject.username,
           moderator.username AS muted_by_username, um.reason,
           um.expires_at, um.unmuted_at, um.created_at
    FROM user_mutes um
    LEFT JOIN "user" subject ON subject.id = um.user_id
    LEFT JOIN "user" moderator ON moderator.id = um.muted_by
    ORDER BY um.created_at DESC
    LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `), db.execute<{ total: string }>(sql`
    SELECT COUNT(*)::text AS total FROM user_mutes
  `)]);
  const mutes = result.rows;
  const total = Number(countResult.rows[0]?.total ?? 0);

  return {
    data: mutes.map((m) => ({
      id: m.id,
      userId: m.user_id,
      username: m.username,
      mutedByUsername: m.muted_by_username,
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
