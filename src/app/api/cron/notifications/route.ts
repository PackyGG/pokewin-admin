import { NextResponse } from "next/server";
import {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type PendingEvent,
  advanceCursor,
  fetchPendingEvents,
  getNotificationConfig,
} from "@/lib/queries/notifications";
import { escapeMarkdownV2, sendTelegram } from "@/lib/telegram";
import { formatCurrency } from "@/lib/utils/format";

/**
 * Vercel Cron endpoint — polls every minute, picks up any new deposits,
 * withdrawals, and signups from the main DB since the last cursor, and
 * forwards them to Telegram via the per-event configs in adminDb.
 *
 * Rules enforced here:
 *   - Must be invoked by Vercel Cron (Authorization: Bearer <CRON_SECRET>).
 *     When CRON_SECRET is unset we refuse every request so a misconfigured
 *     deploy doesn't silently run without auth.
 *   - Each event type has its own cursor — a broken Telegram token for
 *     deposits never stops withdrawals / signups from flowing.
 *   - ONE message per event — no batching or digests. If Telegram rate
 *     limits (429), we stop and retry the remaining events on the next
 *     tick (the cursor only advances through the successful prefix).
 *   - Failures never advance the cursor — the next tick retries.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// How many events we process in one tick. If there's a genuine backlog
// we'll drain it across multiple ticks at this cap; keeps per-tick
// runtime bounded and stays well under Telegram's 20 msgs/minute
// per-chat ceiling.
const BATCH_LIMIT = 20;

type PerTypeSummary = {
  sent: number;
  skipped?: string;
  error?: string;
};

type TickSummary = Record<NotificationEvent, PerTypeSummary> & {
  timestamp: string;
};

export async function GET(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const summary: TickSummary = {
    deposit: { sent: 0 },
    withdrawal: { sent: 0 },
    signup: { sent: 0 },
    timestamp: new Date().toISOString(),
  };

  for (const eventType of NOTIFICATION_EVENTS) {
    try {
      summary[eventType] = await processEventType(eventType);
    } catch (err) {
      // Swallow per-type errors so one broken type doesn't block the others.
      // The error is attached to the summary so `vercel logs` still shows it.
      summary[eventType] = {
        sent: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  return NextResponse.json(summary);
}

async function processEventType(
  eventType: NotificationEvent,
): Promise<PerTypeSummary> {
  const config = await getNotificationConfig(eventType);

  if (!config) return { sent: 0, skipped: "table_missing" };
  if (!config.enabled) return { sent: 0, skipped: "disabled" };
  if (!config.botToken?.trim() || !config.chatId?.trim()) {
    return { sent: 0, skipped: "not_configured" };
  }

  const events = await fetchPendingEvents(eventType, config.cursor, BATCH_LIMIT);
  if (events.length === 0) return { sent: 0 };

  const token = config.botToken;
  const chatId = config.chatId;

  // One message per event — always. If any send fails we break,
  // preserve the cursor at the last successful one, and retry the rest
  // on the next tick. Telegram 429 backoff happens naturally this way.
  let lastSuccessCursor: string | null = null;
  let sent = 0;
  let firstError: string | undefined;

  for (const ev of events) {
    const text = formatPerEventMessage(eventType, ev);
    const result = await sendTelegram(token, chatId, text);
    if (!result.ok) {
      firstError = firstError ?? result.error;
      break;
    }
    sent += 1;
    lastSuccessCursor = cursorFor(eventType, ev);
  }

  if (lastSuccessCursor) {
    await advanceCursor(eventType, lastSuccessCursor);
  }

  return { sent, error: firstError };
}

/**
 * Cursor format per event type:
 *   - deposit / withdrawal: ISO timestamp of the ledger row's created_at.
 *   - signup: ISO timestamp of the user's created_at.
 *
 * Both are strictly greater-than compared on the next tick, so we never
 * resend the same row even if multiple rows share a millisecond.
 */
function cursorFor(eventType: NotificationEvent, event: PendingEvent): string {
  void eventType;
  return event.createdAt.toISOString();
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------
//
// All user-controlled text is run through escapeMarkdownV2 before it hits
// the message body. Static labels are authored with the backslashes
// inlined so we don't accidentally escape our own punctuation.

function formatPerEventMessage(
  eventType: NotificationEvent,
  ev: PendingEvent,
): string {
  const username = ev.username ?? "unknown";
  const safeUsername = escapeMarkdownV2(username);

  if (eventType === "deposit") {
    const amountText = escapeMarkdownV2(formatCurrency(ev.amountUsd));
    const lines = [
      "\ud83d\udcb0 *New deposit*",
      `User: \`${safeUsername}\``,
      `Amount: ${amountText}`,
    ];
    if (ev.extra?.crypto_asset) {
      lines.push(`Method: \`${escapeMarkdownV2(ev.extra.crypto_asset)}\``);
    }
    return lines.join("\n");
  }

  if (eventType === "withdrawal") {
    const amountText = escapeMarkdownV2(formatCurrency(ev.amountUsd));
    const lines = [
      "\ud83d\udcb8 *Withdrawal requested*",
      `User: \`${safeUsername}\``,
      `Amount: ${amountText}`,
    ];
    if (ev.extra?.crypto_asset) {
      lines.push(`Method: \`${escapeMarkdownV2(ev.extra.crypto_asset)}\``);
    }
    return lines.join("\n");
  }

  // signup
  const lines = [
    "\ud83d\udc4b *New signup*",
    `User: \`${safeUsername}\``,
  ];
  if (ev.extra?.country_code) {
    const flag = flagEmoji(ev.extra.country_code);
    const codeSafe = escapeMarkdownV2(ev.extra.country_code.toUpperCase());
    lines.push(`Country: ${flag ? `${flag} ` : ""}${codeSafe}`);
  }
  return lines.join("\n");
}

/**
 * ISO 3166-1 alpha-2 → flag emoji via Unicode regional-indicator pairs.
 * Kept inline here so the cron route doesn't depend on the admin page
 * that owns the primary copy (src/app/(admin)/map/utils.ts) — the route
 * ships on its own function and shouldn't pull in page-level code.
 */
function flagEmoji(alpha2: string): string {
  if (!alpha2 || alpha2.length !== 2) return "";
  const upper = alpha2.toUpperCase();
  const a = upper.charCodeAt(0);
  const b = upper.charCodeAt(1);
  if (a < 65 || a > 90 || b < 65 || b > 90) return "";
  return (
    String.fromCodePoint(0x1f1e6 + (a - 65)) +
    String.fromCodePoint(0x1f1e6 + (b - 65))
  );
}
