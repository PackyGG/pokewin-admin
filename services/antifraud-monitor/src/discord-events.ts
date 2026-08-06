import { createHmac, randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { Config } from "./config.js";

const SEND_TIMEOUT_MS = 5_000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 60_000;
export const DISCORD_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * Circuit state is keyed PER eventKey. A single shared circuit meant five
 * failures on one alert kind silenced EVERY other kind for 60s — including the
 * "antifraud webapp is down" alarm, which is the one alert that must survive a
 * neighbouring stream's bad patch. The key set is fixed and small (the event
 * catalog), so the map is inherently bounded.
 */
const circuits = new Map<
  string,
  { consecutiveFailures: number; openUntil: number }
>();

function circuitFor(eventKey: string): {
  consecutiveFailures: number;
  openUntil: number;
} {
  let circuit = circuits.get(eventKey);
  if (!circuit) {
    circuit = { consecutiveFailures: 0, openUntil: 0 };
    circuits.set(eventKey, circuit);
  }
  return circuit;
}

/** Test-only reset so circuit state cannot bleed between cases. */
export function resetDiscordEventCircuits(): void {
  circuits.clear();
}

export type BotDiscordPayload = {
  embeds: Array<Record<string, unknown>>;
  components?: Array<Record<string, unknown>>;
};

/**
 * `attempted: false` means the request was never put on the wire — the circuit
 * was open, or the payload was unusable. Callers that persist retry state must
 * NOT count these as delivery attempts: doing so let a 60s open circuit at a 1s
 * poll tick inflate a row's attempt_count by ~60 and push its backoff to the
 * 300s ceiling, delaying the alert by minutes after Discord had recovered.
 */
export type BotDiscordEventResult = {
  delivered: boolean;
  attempted: boolean;
  /** Remaining circuit window in seconds, when the circuit blocked the send. */
  retryAfterSeconds?: number;
};

function eventsUrl(ingestUrl: string): string {
  return new URL("/api/antifraud/discord-events", ingestUrl).toString();
}

export async function sendBotDiscordEventDetailed(
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
): Promise<BotDiscordEventResult> {
  const embed = input.payload.embeds[0];
  if (!embed) return { delivered: false, attempted: false };
  const circuit = circuitFor(input.eventKey);
  const now = Date.now();
  if (circuit.openUntil > now) {
    log.warn(
      { eventKey: input.eventKey, retryAt: new Date(circuit.openUntil) },
      "Discord event enqueue circuit is open",
    );
    return {
      delivered: false,
      attempted: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((circuit.openUntil - now) / 1_000),
      ),
    };
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
      recordCircuitFailure(circuit);
      return { delivered: false, attempted: true };
    }
    circuit.consecutiveFailures = 0;
    circuit.openUntil = 0;
    return { delivered: true, attempted: true };
  } catch (error) {
    recordCircuitFailure(circuit);
    log.error(
      { err: error, eventKey: input.eventKey, correlationId },
      "Discord bot event enqueue failed",
    );
    return { delivered: false, attempted: true };
  } finally {
    clearTimeout(timer);
  }
}

function recordCircuitFailure(circuit: {
  consecutiveFailures: number;
  openUntil: number;
}): void {
  circuit.consecutiveFailures += 1;
  if (circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
}

/**
 * Boolean-only wrapper kept for the many producers that only care whether the
 * alert went out. Callers that persist retry state should use
 * `sendBotDiscordEventDetailed` so an unattempted send is not billed as a
 * failed attempt.
 */
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
  const result = await sendBotDiscordEventDetailed(config, log, input);
  return result.delivered;
}
