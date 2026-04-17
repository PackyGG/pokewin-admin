/**
 * Minimal Telegram Bot API wrapper used by the notification cron + the
 * "Send test" action on the notifications settings page.
 *
 * We intentionally don't pull in a Telegram SDK for one API call — the
 * official Bot API is a simple HTTPS POST. Returning a structured result
 * (ok / error) lets the cron loop continue to the next event type on
 * failure instead of crashing the whole run.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

export type TelegramSendResult = {
  ok: boolean;
  error?: string;
};

/**
 * Escapes a string for Telegram's MarkdownV2 parse mode. The Telegram
 * docs list every reserved character here:
 *   https://core.telegram.org/bots/api#markdownv2-style
 *
 * Any of `_*[]()~\`>#+-=|{}.!` must be prefixed with a backslash when
 * used outside of an inline-code block. Callers MUST escape any piece
 * of user-controlled text (usernames, descriptions, amounts, …) before
 * interpolating it into a message body.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (match) => `\\${match}`);
}

/**
 * Sends a Markdown-formatted Telegram message. Returns `{ ok: true }` on
 * success and `{ ok: false, error }` on any failure (HTTP, timeout,
 * Telegram API error). Never throws — the caller shouldn't have to
 * wrap every call in try/catch.
 */
export async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
): Promise<TelegramSendResult> {
  if (!botToken.trim() || !chatId.trim()) {
    return { ok: false, error: "Missing bot token or chat id" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${TELEGRAM_API_BASE}/bot${encodeURIComponent(botToken)}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      },
    );

    // Telegram always returns JSON; parse best-effort. A non-2xx with a
    // valid body carries a human-readable `description` we surface.
    const bodyText = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // fall through — we'll use the raw status/body in the error
    }

    if (!res.ok) {
      const description =
        parsed && typeof parsed === "object" && parsed !== null &&
        "description" in parsed && typeof (parsed as { description: unknown }).description === "string"
          ? (parsed as { description: string }).description
          : bodyText.slice(0, 300);
      return { ok: false, error: `Telegram API ${res.status}: ${description}` };
    }

    // Well-formed success body is `{ ok: true, result: {…} }`.
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed !== null &&
      "ok" in parsed &&
      (parsed as { ok: unknown }).ok === true
    ) {
      return { ok: true };
    }

    // The HTTP call succeeded but Telegram reported a logical failure.
    const description =
      parsed && typeof parsed === "object" && parsed !== null &&
      "description" in parsed && typeof (parsed as { description: unknown }).description === "string"
        ? (parsed as { description: string }).description
        : "Unknown Telegram error";
    return { ok: false, error: description };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "Telegram request timed out" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    clearTimeout(timeout);
  }
}
