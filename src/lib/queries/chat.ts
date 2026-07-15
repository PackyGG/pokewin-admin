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
  const db = await getDb();
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

export type TopChatterEntry = {
  userId: string;
  username: string | null;
  image: string | null;
  role: string;
  messageCount: number;
  position: number;
};

const TOP_CHATTERS_LIMIT = 200;

/** UTC calendar-day window as naive 'YYYY-MM-DD HH:MM:SS' strings (no JS
 *  Date round-trip through the pg driver) so the range compares directly
 *  against `chat_messages.created_at` (`timestamp without time zone`) with
 *  no timezone conversion — same convention `src/lib/queries/races.ts`'s live
 *  standings use for game_sessions/race_periods (also naive timestamp
 *  columns). A fixed UTC calendar day, not a rolling 24h window. */
function utcTodayWindowNaive(): { startNaive: string; endNaive: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const fmt = (dt: Date) => dt.toISOString().slice(0, 19).replace("T", " ");
  return {
    startNaive: fmt(new Date(Date.UTC(y, m, d))),
    endNaive: fmt(new Date(Date.UTC(y, m, d + 1))),
  };
}

type TopChatterRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  role: string;
  msg_count: bigint;
};

/**
 * Live (uncached) compute of today's top chatters.
 *
 * Was wrapped in `unstable_cache` (20s revalidate) — dropped 2026-07-15
 * after the live admin kept showing "no chatters" while a direct read-only
 * probe against the same prod DB, running this exact SQL, returned rows
 * (Index Only Scan, sub-ms). DB connectivity and every other admin surface
 * reading `chat_messages` were confirmed fine, so caching was the only
 * unverified link in the chain — and the code's own prior comment already
 * called it "not a real load concern at current chat volume". Removed
 * rather than debugged further since it wasn't load-bearing.
 *
 * Index-safety: backed by `idx_chat_messages_created_at_user_id` (partial,
 * `WHERE is_deleted = false`) — see prisma/recommended-indexes.sql #33.
 */
async function queryTopChattersToday(
  startNaive: string,
  endNaive: string,
  limit: number,
): Promise<{ rows: TopChatterRow[]; totalChatters: number }> {
  const db = await getDb();
  const [rows, totalRes] = await Promise.all([
    db.$queryRaw<TopChatterRow[]>`
      SELECT cm.user_id, u.username, u.image, u.role::text AS role,
             COUNT(*)::bigint AS msg_count
      FROM chat_messages cm
      JOIN "user" u ON u.id = cm.user_id
      WHERE cm.is_deleted = false
        AND cm.created_at >= ${startNaive}::timestamp
        AND cm.created_at <  ${endNaive}::timestamp
      GROUP BY cm.user_id, u.username, u.image, u.role
      ORDER BY msg_count DESC, cm.user_id ASC
      LIMIT ${limit}
    `,
    db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT cm.user_id)::bigint AS count
      FROM chat_messages cm
      WHERE cm.is_deleted = false
        AND cm.created_at >= ${startNaive}::timestamp
        AND cm.created_at <  ${endNaive}::timestamp
    `,
  ]);
  return { rows, totalChatters: Number(totalRes[0]?.count ?? 0) };
}

/**
 * Most active chat senders for the CURRENT UTC calendar day (resets at
 * 00:00 UTC — a fixed calendar day, not a rolling 24h window). Computed
 * live from `chat_messages` — there is no daily chat-activity snapshot
 * table, so "today" always has to be a live aggregate (same reasoning as
 * the running-race live standings in `src/lib/queries/races.ts`).
 */
export async function getTopChattersToday(
  limit = TOP_CHATTERS_LIMIT,
): Promise<{ entries: TopChatterEntry[]; totalChatters: number }> {
  const { startNaive, endNaive } = utcTodayWindowNaive();
  const { rows, totalChatters } = await queryTopChattersToday(
    startNaive,
    endNaive,
    limit,
  );

  return {
    entries: rows.map((r, i) => ({
      userId: r.user_id,
      username: r.username,
      image: r.image,
      role: r.role,
      messageCount: Number(r.msg_count),
      position: i + 1,
    })),
    totalChatters,
  };
}
