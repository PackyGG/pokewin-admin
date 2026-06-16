import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getChatMessagesTodayFromClickHouse } from "@/lib/clickhouse/queries/dashboard/chat-messages-today";

/**
 * On-site chat volume for the dashboard "Chat messages (today)" tile.
 *
 * Window: [today 00:00 UTC, now) — same UTC-midnight boundary as P&L Today,
 * Reward Costs, and Creators Costs so operators reconcile on one "today".
 *
 * Counts every row in `chat_messages` by `created_at` (messages sent today,
 * including later soft-deleted rows — deletion is moderation, not unsend).
 */

export type ChatMessagesToday = {
  /** Messages created since UTC midnight today. */
  messageCount: number;
  /** Distinct senders in that window. */
  uniqueChatters: number;
  /** Subset later marked deleted (chip on the card). */
  deletedCount: number;
  /** ISO timestamp of the window start (today 00:00 UTC). */
  dayStartIso: string;
};

function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const cachedChatMessagesToday = unstable_cache(
  async (dayKey: string, sinceIso: string): Promise<Omit<ChatMessagesToday, "dayStartIso">> => {
    void dayKey;
    return withTiming("dashboard.chatMessagesToday", async () => {
      // CQRS serve-path: clickhouse serves the CH twin (SOLE read);
      // off/comparison serve Postgres. Parity confirmed exact (CDC-lag only).
      return resolveAdminRead<Omit<ChatMessagesToday, "dayStartIso">>(
        "dashboard_chat_messages_today",
        {
          pg: async () => {
            const db = await getDb();
            type Row = {
              message_count: string;
              unique_chatters: string;
              deleted_count: string;
            };
            const rows = await db.$queryRawUnsafe<Row[]>(
              `SELECT
                 COUNT(*)::text AS message_count,
                 COUNT(DISTINCT user_id)::text AS unique_chatters,
                 COUNT(*) FILTER (WHERE is_deleted)::text AS deleted_count
               FROM chat_messages
               WHERE created_at >= $1::timestamptz`,
              sinceIso,
            );
            const r = rows[0];
            return {
              messageCount: toNumber(r?.message_count),
              uniqueChatters: toNumber(r?.unique_chatters),
              deletedCount: toNumber(r?.deleted_count),
            };
          },
          ch: () => getChatMessagesTodayFromClickHouse(new Date(sinceIso)),
        },
      );
    });
  },
  ["dashboard-chat-messages-today-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

export async function getChatMessagesToday(): Promise<ChatMessagesToday> {
  return withTiming("dashboard.chatMessagesToday.entry", async () => {
    const now = new Date();
    const since = utcStartOfDay(now);
    const sinceIso = since.toISOString();
    const dayKey = sinceIso.slice(0, 10);
    const counts = await cachedChatMessagesToday(dayKey, sinceIso);
    return { ...counts, dayStartIso: sinceIso };
  });
}
