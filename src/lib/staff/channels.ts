import "server-only";

import { randomUUID } from "node:crypto";

import { enqueueDiscordEvent } from "@/lib/discord-notifications/router";

/**
 * Outbound notification channels for staff pings — Discord (default, delivered
 * by the Discord bot) and Telegram (opt-in, Bot API).
 *
 * Both are OPTIONAL integrations: an unconfigured channel is a valid state, the
 * feature is simply off for it, and the in-app bell keeps working regardless.
 * Nothing here ever throws at a call site — every send resolves to a result
 * object so a dead channel can never break a quiz submit or a review update.
 *
 * SECURITY: the Telegram bot token is read from the environment at send time
 * and NEVER returned, logged, or surfaced in a status string. The `configured`
 * helpers report only presence.
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
 * Discord delivery goes through the BOT, not a raw channel webhook. The ping is
 * queued as a `staff.announcement` event and the bot posts it to whichever
 * channel that event is assigned to on Fraud → Discord Routing, opening with a
 * `<@id>` mention — the same "basically ping them" behaviour as before, with
 * one delivery path for the whole dashboard instead of a private webhook URL.
 *
 * The old `ANTIFRAUD_DISCORD_WEBHOOK_URL` is gone. `ADMIN_GUILD_ID` is the only
 * thing this needs; an unset guild means the integration is simply off.
 */
const STAFF_ANNOUNCEMENT_EVENT_KEY = "staff.announcement";

function adminGuildId(): string | undefined {
  return process.env.ADMIN_GUILD_ID || undefined;
}

export function isDiscordChannelConfigured(): boolean {
  return Boolean(adminGuildId());
}

/**
 * Ping one staff member on Discord. `target` is their Discord user id
 * (snowflake) — 17–20 digits.
 *
 * The bot pins `allowed_mentions` to the ids it is given when it posts, so a
 * title or body containing `@everyone` can never escalate into a mass ping.
 */
export async function sendDiscordPing(params: {
  target: string;
  title: string;
  body?: string | null;
  href?: string | null;
}): Promise<ChannelSendResult> {
  const guildId = adminGuildId();
  if (!guildId) {
    return {
      ok: false,
      skipped: true,
      error: "Discord is not configured on this deployment",
    };
  }
  if (!/^\d{15,25}$/.test(params.target)) {
    return { ok: false, error: "Invalid Discord user id" };
  }

  const lines = [params.title];
  if (params.body) lines.push(params.body);

  try {
    const { enqueued } = await enqueueDiscordEvent({
      guildId,
      eventKey: STAFF_ANNOUNCEMENT_EVENT_KEY,
      // Unique per send: two identical announcements to the same person are two
      // real pings, and the queue's own retry handles redelivery.
      dedupeKey: `staff:${params.target}:${randomUUID()}`,
      content: truncate(`<@${params.target}>`),
      embed: {
        title: truncate(params.title),
        description: truncate(lines.slice(1).join("\n")) || undefined,
        ...(params.href ? { url: params.href } : {}),
        color: 0x5865f2,
        timestamp: new Date().toISOString(),
      },
    });
    if (enqueued === 0) {
      // The event exists but no channel is assigned to it, so nothing would
      // ever be posted. Say so instead of reporting a delivery that isn't one.
      return {
        ok: false,
        error:
          "No Discord channel is assigned to staff announcements — set one on Discord Routing",
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Discord delivery failed",
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
