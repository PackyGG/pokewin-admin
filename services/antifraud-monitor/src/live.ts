import { randomBytes } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";
import type { WebSocket } from "ws";

import type { LiveMessage } from "./types.js";

const CHANNEL = "antifraud:live";
const STREAM = "antifraud:live:stream";
const STREAM_MAX_LEN = 2_000;
const REPLAY_MAX_ENTRIES = 200;
const MAX_BUFFERED_BYTES = 512 * 1024;
const HEARTBEAT_MS = 30_000;

/** Every frame on the wire carries the replay id of its stream entry. */
export type LiveEnvelope = LiveMessage & { id: string };

export const STREAM_ID_PATTERN = /^\d{1,20}-\d{1,20}$/;

export function parseEnvelope(id: string, raw: string): LiveEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const value = parsed as Partial<LiveMessage>;
  if (
    typeof value.type !== "string" ||
    typeof value.at !== "string" ||
    value.data === null ||
    typeof value.data !== "object" ||
    Array.isArray(value.data)
  ) {
    return null;
  }
  return {
    id,
    type: value.type,
    at: value.at,
    data: value.data as Record<string, unknown>,
  };
}

export class LiveBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly clients = new Set<WebSocket>();
  private readonly clientsByActor = new Map<string, number>();
  private subscribed = false;
  private closing = false;

  constructor(
    redisUrl: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.publisher = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    this.subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });

    this.publisher.on("error", (error: Error) => {
      this.log.error({ err: error }, "Antifraud live publisher redis error");
    });
    this.publisher.on("end", () => {
      if (this.closing) return;
      this.log.warn("Antifraud live publisher redis connection ended");
    });
    this.subscriber.on("error", (error: Error) => {
      this.log.error({ err: error }, "Antifraud live subscriber redis error");
    });
    this.subscriber.on("end", () => {
      this.subscribed = false;
      if (this.closing) return;
      this.log.warn("Antifraud live subscriber redis connection ended");
    });
    this.subscriber.on("ready", () => {
      // ioredis only auto-resubscribes channels recorded by a SUCCESSFUL
      // subscribe, so re-issue it on every (re)connect. SUBSCRIBE is idempotent.
      void this.ensureSubscribed();
    });

    this.subscriber.on("message", (_channel: string, payload: string) => {
      for (const client of this.clients) {
        if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
          client.terminate();
        } else if (client.readyState === client.OPEN) {
          client.send(payload);
        }
      }
    });
  }

  /**
   * Must complete before the process starts serving. A rejected subscribe fails
   * the boot so the platform restart policy retries instead of leaving the
   * service publishing into a channel with zero subscribers.
   */
  async start(): Promise<void> {
    await this.subscriber.subscribe(CHANNEL);
    this.subscribed = true;
  }

  isSubscribed(): boolean {
    return this.subscribed;
  }

  private async ensureSubscribed(): Promise<void> {
    try {
      await this.subscriber.subscribe(CHANNEL);
      this.subscribed = true;
    } catch (error) {
      this.subscribed = false;
      this.log.error(
        { err: error },
        "Failed to subscribe to the antifraud live channel",
      );
    }
  }

  async publish(type: string, data: Record<string, unknown>): Promise<void> {
    const message: LiveMessage = {
      type,
      at: new Date().toISOString(),
      data,
    };
    let id = "";
    try {
      id =
        (await this.publisher.xadd(
          STREAM,
          "MAXLEN",
          "~",
          STREAM_MAX_LEN,
          "*",
          "payload",
          JSON.stringify(message),
        )) ?? "";
    } catch (error) {
      this.log.error(
        { err: error },
        "Failed to append an antifraud live event to the replay stream",
      );
    }
    await this.publisher.publish(
      CHANNEL,
      JSON.stringify({ id, ...message } satisfies LiveEnvelope),
    );
  }

  /**
   * Bounded catch-up for a reconnecting client. `afterId` is the last id the
   * client saw (exclusive); omit it to get the most recent `limit` events.
   */
  async replay(afterId: string | null, limit: number): Promise<LiveEnvelope[]> {
    const count = Math.min(Math.max(limit, 1), REPLAY_MAX_ENTRIES);
    const entries: Array<[string, string[]]> = afterId
      ? await this.publisher.xrange(STREAM, afterId, "+", "COUNT", count + 1)
      : (
        await this.publisher.xrevrange(STREAM, "+", "-", "COUNT", count)
      ).reverse();

    const messages: LiveEnvelope[] = [];
    for (const [id, fields] of entries) {
      if (afterId && id === afterId) continue;
      const index = fields.indexOf("payload");
      const raw = index >= 0 ? fields[index + 1] : undefined;
      const message = raw ? parseEnvelope(id, raw) : null;
      if (message) messages.push(message);
      if (messages.length === count) break;
    }
    return messages;
  }

  addClient(client: WebSocket, actorId: string): boolean {
    const actorConnections = this.clientsByActor.get(actorId) ?? 0;
    if (actorConnections >= 3 || this.clients.size >= 500) return false;

    this.clients.add(client);
    this.clientsByActor.set(actorId, actorConnections + 1);
    let released = false;
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        client.terminate();
        return;
      }
      alive = false;
      client.ping();
    }, HEARTBEAT_MS);
    client.on("pong", () => {
      alive = true;
    });
    client.on("close", () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      this.clients.delete(client);
      const remaining = (this.clientsByActor.get(actorId) ?? 1) - 1;
      if (remaining <= 0) this.clientsByActor.delete(actorId);
      else this.clientsByActor.set(actorId, remaining);
    });
    client.send(JSON.stringify({
      id: "",
      type: "connected",
      at: new Date().toISOString(),
      data: {},
    } satisfies LiveEnvelope));
    return true;
  }

  async createTicket(actor: Record<string, unknown>): Promise<string> {
    const ticket = randomBytes(32).toString("base64url");
    await this.publisher.set(
      `antifraud:ws-ticket:${ticket}`,
      JSON.stringify(actor),
      "EX",
      30,
      "NX",
    );
    return ticket;
  }

  async consumeTicket(ticket: string): Promise<{ actorId: string } | null> {
    const key = `antifraud:ws-ticket:${ticket}`;
    const result = await this.publisher.call("GETDEL", key);
    if (typeof result !== "string") return null;
    try {
      const parsed = JSON.parse(result) as { actorId?: unknown };
      return typeof parsed.actorId === "string" && parsed.actorId.length > 0
        ? { actorId: parsed.actorId }
        : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const client of this.clients) client.close(1001, "Server shutdown");
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
