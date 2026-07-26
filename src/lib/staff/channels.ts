import "server-only";

/**
 * Outbound notification channels for staff pings — Discord (default) and
 * Telegram (opt-in).
 *
 * Both are OPTIONAL integrations: an unconfigured channel is a valid state, the
 * feature is simply off for it, and the in-app bell keeps working regardless.
 * Nothing here ever throws at a call site — every send resolves to a result
 * object so a dead webhook can never break a quiz submit or a review update.
 *
 * SECURITY: the bot token / webhook URL are read from the environment at send
 * time and NEVER returned, logged, or surfaced in a status string. The
 * `configured` helpers report only presence.
 */

export type ChannelKind = "discord" | "telegram";

export type ChannelSendResult =
  | { ok: true; skipped?: false }
  /** The channel isn't configured on this deployment — not an error. */
  | { ok: false; skipped: true; error: string }
  | { ok: false; skipped?: false; error: string };

/** Hard ceiling on any outbound message so a runaway payload can't be sent. */
const MAX_MESSAGE_CHARS = 1800;

/** Wall-clock budget per delivery. A slow webhook must not stall a mutation. */
const SEND_TIMEOUT_MS = 5_000;

function truncate(text: string): string {
  return text.length <= MAX_MESSAGE_CHARS
    ? text
    : text.slice(0, MAX_MESSAGE_CHARS - 1) + "…";
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    // Read at most a short slice of the body for the error line — a provider
    // error page must not end up multi-kilobyte in our logs.
    const text = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200);
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Discord ──────────────────────────────────────────────────────────────

/**
 * Discord delivery goes through a channel WEBHOOK, and the message opens with
 * a `<@id>` mention — which is exactly the "basically ping them" behaviour the
 * staff notification system is for, without needing a bot process, gateway
 * connection or per-user DM consent.
 *
 * `ANTIFRAUD_DISCORD_WEBHOOK_URL` — a Discord channel webhook URL.
 */
function discordWebhookUrl(): string | undefined {
  return process.env.ANTIFRAUD_DISCORD_WEBHOOK_URL || undefined;
}

export function isDiscordChannelConfigured(): boolean {
  return Boolean(discordWebhookUrl());
}

/**
 * Ping one staff member on Discord. `target` is their Discord user id
 * (snowflake) — 17–20 digits.
 *
 * `allowed_mentions` is pinned to exactly the one user id we intend to ping, so
 * a title or body containing `@everyone` (or any other mention-looking text)
 * can never escalate into a mass ping.
 */
export async function sendDiscordPing(params: {
  target: string;
  title: string;
  body?: string | null;
  href?: string | null;
}): Promise<ChannelSendResult> {
  const url = discordWebhookUrl();
  if (!url) {
    return {
      ok: false,
      skipped: true,
      error: "Discord is not configured on this deployment",
    };
  }
  if (!/^\d{15,25}$/.test(params.target)) {
    return { ok: false, error: "Invalid Discord user id" };
  }

  const lines = [`<@${params.target}> **${params.title}**`];
  if (params.body) lines.push(params.body);
  if (params.href) lines.push(params.href);

  try {
    const res = await postJson(url, {
      content: truncate(lines.join("\n")),
      allowed_mentions: { parse: [], users: [params.target] },
    });
    if (!res.ok) {
      return { ok: false, error: `Discord returned ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === "AbortError"
          ? "Discord timed out"
          : "Discord delivery failed",
    };
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────

/**
 * Telegram delivery uses the Bot API directly. `ANTIFRAUD_TELEGRAM_BOT_TOKEN`
 * is a bot token from @BotFather; `target` is the numeric chat id of the DM the
 * staff member has opened with that bot (which is why the channel needs
 * verification — a bot cannot message a user who never started a chat).
 */
function telegramBotToken(): string | undefined {
  return process.env.ANTIFRAUD_TELEGRAM_BOT_TOKEN || undefined;
}

export function isTelegramChannelConfigured(): boolean {
  return Boolean(telegramBotToken());
}

/** Escape the characters Telegram's HTML parse mode treats as markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendTelegramPing(params: {
  target: string;
  title: string;
  body?: string | null;
  href?: string | null;
}): Promise<ChannelSendResult> {
  const token = telegramBotToken();
  if (!token) {
    return {
      ok: false,
      skipped: true,
      error: "Telegram is not configured on this deployment",
    };
  }
  // Chat ids are numeric; group ids are negative.
  if (!/^-?\d{1,20}$/.test(params.target)) {
    return { ok: false, error: "Invalid Telegram chat id" };
  }

  const lines = [`<b>${escapeHtml(params.title)}</b>`];
  if (params.body) lines.push(escapeHtml(params.body));
  if (params.href) lines.push(escapeHtml(params.href));

  try {
    const res = await postJson(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: params.target,
        text: truncate(lines.join("\n")),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
    );
    if (!res.ok) {
      // 403 is the common, actionable one: the staff member never pressed
      // /start, so the bot may not DM them.
      return {
        ok: false,
        error:
          res.status === 403
            ? "Telegram blocked the message — open a chat with the bot and press Start"
            : `Telegram returned ${res.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === "AbortError"
          ? "Telegram timed out"
          : "Telegram delivery failed",
    };
  }
}

// ─── Shared ───────────────────────────────────────────────────────────────

/** Dispatch to the right provider. */
export function sendOnChannel(
  channel: ChannelKind,
  params: { target: string; title: string; body?: string | null; href?: string | null },
): Promise<ChannelSendResult> {
  return channel === "telegram"
    ? sendTelegramPing(params)
    : sendDiscordPing(params);
}

/** Whether a given channel can deliver at all on this deployment. */
export function isChannelConfigured(channel: ChannelKind): boolean {
  return channel === "telegram"
    ? isTelegramChannelConfigured()
    : isDiscordChannelConfigured();
}

/**
 * Operator-facing config status for the profile page. Presence only — never the
 * token, never any part of the URL.
 */
export function channelConfigStatus(): Record<ChannelKind, boolean> {
  return {
    discord: isDiscordChannelConfigured(),
    telegram: isTelegramChannelConfigured(),
  };
}
