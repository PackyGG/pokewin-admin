import { createHmac } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { Config } from "./config.js";

const SEND_TIMEOUT_MS = 5_000;

export type BotDiscordPayload = {
  content?: string;
  embeds: Array<Record<string, unknown>>;
};

function eventsUrl(ingestUrl: string): string {
  return new URL("/api/antifraud/discord-events", ingestUrl).toString();
}

export async function sendBotDiscordEvent(
  config: Pick<
    Config,
    "ADMIN_GUILD_ID" | "ANTIFRAUD_INGEST_URL" | "ANTIFRAUD_INGEST_SECRET"
  >,
  log: FastifyBaseLogger,
  input: {
    eventKey: string;
    dedupeKey: string;
    payload: BotDiscordPayload;
  },
): Promise<boolean> {
  const embed = input.payload.embeds[0];
  if (!embed) return false;

  const body = JSON.stringify({
    guildId: config.ADMIN_GUILD_ID,
    eventKey: input.eventKey,
    dedupeKey: input.dedupeKey,
    embed,
    ...(input.payload.content ? { content: input.payload.content } : {}),
  });
  const timestamp = String(Date.now());
  const signature =
    "sha256=" +
    createHmac("sha256", config.ANTIFRAUD_INGEST_SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(eventsUrl(config.ANTIFRAUD_INGEST_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-antifraud-timestamp": timestamp,
        "x-antifraud-signature": signature,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      log.error(
        { status: response.status, eventKey: input.eventKey },
        "Discord bot event enqueue failed",
      );
      return false;
    }
    return true;
  } catch (error) {
    log.error(
      { err: error, eventKey: input.eventKey },
      "Discord bot event enqueue failed",
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}
