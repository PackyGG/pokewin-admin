import { createHmac, randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { Config } from "./config.js";

const SEND_TIMEOUT_MS = 5_000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 60_000;
export const DISCORD_EVENT_SCHEMA_VERSION = 1 as const;

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

export type BotDiscordPayload = {
  embeds: Array<Record<string, unknown>>;
  components?: Array<Record<string, unknown>>;
};

function eventsUrl(ingestUrl: string): string {
  return new URL("/api/antifraud/discord-events", ingestUrl).toString();
}

export async function sendBotDiscordEvent(
  config: Pick<
    Config,
    "ADMIN_GUILD_ID" | "ANTIFRAUD_INGEST_URL" | "ANTIFRAUD_INGEST_SECRET"
  >,
  log: Pick<FastifyBaseLogger, "warn" | "error">,
  input: {
    eventKey: string;
    dedupeKey: string;
    payload: BotDiscordPayload;
  },
): Promise<boolean> {
  const embed = input.payload.embeds[0];
  if (!embed) return false;
  const now = Date.now();
  if (circuitOpenUntil > now) {
    log.warn(
      { eventKey: input.eventKey, retryAt: new Date(circuitOpenUntil) },
      "Discord event enqueue circuit is open",
    );
    return false;
  }

  const correlationId = randomUUID();
  const body = JSON.stringify({
    schemaVersion: DISCORD_EVENT_SCHEMA_VERSION,
    correlationId,
    guildId: config.ADMIN_GUILD_ID,
    eventKey: input.eventKey,
    dedupeKey: input.dedupeKey,
    embed,
    components: input.payload.components ?? [],
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
        "x-correlation-id": correlationId,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      log.error(
        { status: response.status, eventKey: input.eventKey, correlationId },
        "Discord bot event enqueue failed",
      );
      consecutiveFailures += 1;
      if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      }
      return false;
    }
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    return true;
  } catch (error) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    }
    log.error(
      { err: error, eventKey: input.eventKey, correlationId },
      "Discord bot event enqueue failed",
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}
