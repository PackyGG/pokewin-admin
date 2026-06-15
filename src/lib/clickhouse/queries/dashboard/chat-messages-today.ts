import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime } from "../_shared";

/**
 * Phase 2B — Dashboard "Chat messages (today)" tile, read from the ClickHouse
 * prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getChatMessagesToday`
 * (src/lib/queries/dashboard-chat-messages-today.ts). Mirrors the SAME three
 * counts over the SAME window `[since, now)` (today 00:00 UTC, passed in):
 *
 *   • messageCount   = COUNT(*) of chat_messages WHERE created_at >= since
 *                      (every row, including later soft-deleted ones).
 *   • uniqueChatters = COUNT(DISTINCT user_id) over that window — `uniqExact`
 *                      (EXACT distinct, never the approximate `uniq`).
 *   • deletedCount   = COUNT(*) FILTER (WHERE is_deleted) → `countIf(is_deleted)`.
 *
 * NO user scope (the PG twin counts every chat row by created_at). All three
 * are counts → comparison requires an EXACT match (no money tolerance); a
 * residual on the freshest "today" window is CDC-lag, not structural drift.
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0` (CDC tombstone =
 * row hard-deleted in PG; distinct from the app-level moderation `is_deleted`
 * flag the PG twin also reads).
 */

export type ChatMessagesTodayCh = {
  messageCount: number;
  uniqueChatters: number;
  deletedCount: number;
};

type Row = {
  message_count: string;
  unique_chatters: string;
  deleted_count: string;
};

export async function getChatMessagesTodayFromClickHouse(
  since: Date,
): Promise<ChatMessagesTodayCh> {
  const cutoff = chDateTime(since);
  const params: Record<string, unknown> = { cutoff };

  const sql = `
    SELECT
      toString(count())                  AS message_count,
      toString(uniqExact(cm.user_id))    AS unique_chatters,
      toString(countIf(cm.is_deleted))   AS deleted_count
    FROM ${CH_DB}.public_chat_messages AS cm FINAL
    WHERE cm._peerdb_is_deleted = 0
      AND cm.created_at >= {cutoff:DateTime64(6)}`;

  const rows = await clickhouseRead.query<Row>({
    queryName: "dashboard.chatMessagesToday",
    sql,
    params,
  });
  const r = rows[0];
  return {
    messageCount: Number(r?.message_count ?? 0),
    uniqueChatters: Number(r?.unique_chatters ?? 0),
    deletedCount: Number(r?.deleted_count ?? 0),
  };
}
