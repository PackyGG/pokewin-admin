import { requirePageAccess } from "@/lib/dal";
import {
  getChatMessagesSince,
  type ChatMessageItem,
} from "@/lib/queries/chat";
import { sseResponse } from "@/lib/sse";

// Stream keeps the connection open for minutes at a time — disable
// framework caching and stay on the Node runtime (Prisma via pg).
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Live chat messages over SSE. Replaces the 3s `pollMessages` cycle in
 * `src/components/chat-panel/chat-panel-chat.tsx`.
 *
 * Initial connect emits `event: init` with an empty array — the panel
 * already paints the existing messages via `fetchChatMessagesPanel()` on
 * mount, so the SSE stream only needs to deliver NEW rows from the
 * moment the client connects. The cursor is initialised to "now" on the
 * first tick so we never replay history the client already has.
 */
export async function GET(request: Request): Promise<Response> {
  await requirePageAccess("/chat");

  const connectedAt = new Date().toISOString();

  return sseResponse<ChatMessageItem>({
    request,
    initial: async () => {
      // Nothing to replay — the chat panel loads its initial slice via
      // the existing paginated server action. Seed the cursor at the
      // moment the SSE connection opened so we only emit strictly-newer
      // rows from here on.
      return { rows: [], cursor: connectedAt };
    },
    produce: async (lastCursor) => {
      const cursor = lastCursor ?? connectedAt;
      const rows = await getChatMessagesSince(cursor, 100);
      if (rows.length === 0) {
        return { rows: [], nextCursor: null };
      }
      // Rows already ascending from the query, so the last element is
      // the newest — advance the cursor to its createdAt.
      return {
        rows,
        nextCursor: rows[rows.length - 1].createdAt,
      };
    },
    intervalMs: 3000,
  });
}
