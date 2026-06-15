import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import { getChatMessagesTodayFromClickHouse } from "../queries/dashboard/chat-messages-today";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard "Chat messages (today)" tile
 * (`getChatMessagesToday`). No-op unless the `dashboard_chat_messages_today`
 * surface is in `comparison` mode (forced off whenever ClickHouse is dormant).
 * Swallows every error — the served Postgres payload is never affected.
 *
 * All three fields are counts → diffed with NO money tolerance (must match
 * exactly). The CH twin reuses the SAME window start the PG path computed
 * (today 00:00 UTC, `dayStartIso`). A residual on this freshest window is
 * CDC-lag, not structural drift.
 */
export async function compareDashboardChatMessagesToday(pgValues: {
  messageCount: number;
  uniqueChatters: number;
  deletedCount: number;
  dayStartIso: string;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_chat_messages_today");
    if (mode !== "comparison") return;

    const since = new Date(pgValues.dayStartIso);
    const { result: ch, durationMs } = await timeCh(async () =>
      getChatMessagesTodayFromClickHouse(since),
    );
    const drift = computeDrift(
      {
        messageCount: pgValues.messageCount,
        uniqueChatters: pgValues.uniqueChatters,
        deletedCount: pgValues.deletedCount,
      },
      {
        messageCount: ch.messageCount,
        uniqueChatters: ch.uniqueChatters,
        deletedCount: ch.deletedCount,
      },
    );
    logComparison("dashboard.chatMessagesToday", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_chat_messages_today",
      "comparison failed (ignored)",
      err,
    );
  }
}
