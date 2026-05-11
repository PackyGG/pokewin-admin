import { requirePageAccess } from "@/lib/dal";
import {
  getChatMessagesSince,
  type ChatMessageItem,
} from "@/lib/queries/chat";
import { sseResponse } from "@/lib/sse";

// Per-user concurrent-stream cap (1) for THIS route in THIS Node.js
// process. One stream per user — multiple tabs would just multiply DB
// poll load for identical data. In-memory only — per-instance, not
// global. Acceptable until a shared cache is wired up.
const MAX_CONCURRENT = 1;
const openStreams = new Map<string, number>();

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
  const session = await requirePageAccess("/chat");
  const userId = session.userId;

  // Cap per-user concurrent SSE streams. Rejects the 4th with 429.
  const currentOpen = openStreams.get(userId) ?? 0;
  if (currentOpen >= MAX_CONCURRENT) {
    return new Response("Too many concurrent streams", { status: 429 });
  }
  openStreams.set(userId, currentOpen + 1);
  let decremented = false;
  const decrementOnce = () => {
    if (decremented) return;
    decremented = true;
    const next = (openStreams.get(userId) ?? 1) - 1;
    if (next <= 0) openStreams.delete(userId);
    else openStreams.set(userId, next);
  };

  const connectedAt = new Date().toISOString();

  return sseResponse<ChatMessageItem>({
    request,
    onClose: decrementOnce,
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
    intervalMs: 6000,
  });
}
