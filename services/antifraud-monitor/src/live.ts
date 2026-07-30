import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";
import type pg from "pg";
import type { WebSocket } from "ws";

import {
  LIVE_EVENT_TYPES,
  LIVE_SCHEMA_VERSION,
  type LiveEventType,
  type LiveMessage,
} from "./types.js";

const CHANNEL = "antifraud:live";
const STREAM = "antifraud:live:stream";
const STREAM_MAX_LEN = 2_000;
const REPLAY_MAX_ENTRIES = 200;
const MAX_BUFFERED_BYTES = 512 * 1024;
const HEARTBEAT_MS = 30_000;
/** Grace before a coded close escalates to terminate on an unresponsive peer. */
const EVICTION_TERMINATE_MS = 2_000;
const PUBLISH_RETRY_DELAY_MS = 250;
const TICKET_TTL_SECONDS = 30;
const TICKET_CREATE_ATTEMPTS = 3;
/** Default per-actor cap; override via LiveBusOptions.maxConnectionsPerActor. */
export const MAX_CONNECTIONS_PER_ACTOR = 8;
/** Default global cap; override via LiveBusOptions.maxConnections. */
export const MAX_CONNECTIONS = 500;
/**
 * Default absolute session lifetime. A consumed ticket must not authorize an
 * unbounded feed: revoked staff would otherwise keep their live stream until
 * the next disconnect. The proxy re-tickets transparently on reconnect.
 */
export const SESSION_MAX_AGE_MS = 60 * 60_000;
const OUTBOX_DRAIN_INTERVAL_MS = 5_000;
const OUTBOX_DRAIN_BATCH = 50;
/** Depth reporting is capped: "1000+" is already an alarm, exact size is not. */
const OUTBOX_DEPTH_CAP = 1_000;

const PUBLISH_SCRIPT = `
local id = redis.call(
  "XADD",
  KEYS[1],
  "MAXLEN",
  "~",
  ARGV[1],
  "*",
  "payload",
  ARGV[2]
)
local envelope = '{"id":"' .. id .. '",' .. string.sub(ARGV[2], 2)
redis.call("PUBLISH", KEYS[2], envelope)
return id
`;

/** Every frame on the wire carries the replay id of its stream entry. */
export type LiveEnvelope = LiveMessage & { id: string };

export type LiveReplayResult = {
  events: LiveEnvelope[];
  /**
   * Last SCANNED stream id (parsed or not), so pagination advances past
   * unparseable entries instead of stalling on them. Null when nothing was
   * scanned.
   */
  cursor: string | null;
  /**
   * True when the requested `afterId` predates the oldest retained entry: the
   * stream was trimmed past the caller's cursor and it must resync.
   */
  truncated: boolean;
};

export const STREAM_ID_PATTERN = /^\d{1,20}-\d{1,20}$/;

/** Numeric ordering of two Redis stream ids (`ms-seq`). */
export function compareStreamIds(a: string, b: string): number {
  const [aMs = 0n, aSeq = 0n] = a.split("-").map(BigInt);
  const [bMs = 0n, bSeq = 0n] = b.split("-").map(BigInt);
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isLiveEventType(value: string): value is LiveEventType {
  return (LIVE_EVENT_TYPES as readonly string[]).includes(value);
}

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
    !isLiveEventType(value.type) ||
    typeof value.at !== "string" ||
    value.data === null ||
    typeof value.data !== "object" ||
    Array.isArray(value.data)
  ) {
    return null;
  }
  const correlationId =
    typeof value.correlationId === "string" &&
    CORRELATION_ID_PATTERN.test(value.correlationId)
      ? value.correlationId
      : `legacy:${id}`;
  return {
    id,
    schemaVersion: LIVE_SCHEMA_VERSION,
    correlationId,
    type: value.type,
    at: value.at,
    data: value.data as Record<string, unknown>,
  };
}

export type LiveBusOptions = {
  publisher?: Redis;
  subscriber?: Redis;
  /**
   * Durable fallback store for frames Redis rejected. Without it, a publish
   * that fails after the retry is permanently lost (pre-044 behavior).
   */
  outboxPool?: pg.Pool;
  maxConnectionsPerActor?: number;
  maxConnections?: number;
  sessionMaxAgeMs?: number;
  drainIntervalMs?: number;
};

export type LiveBusStats = {
  subscribed: boolean;
  publishFailures: number;
  clients: number;
  /** Undelivered outbox rows as of the last drain tick, capped at 1000. */
  outboxDepth: number;
  /** Largest per-actor connection counts (top 5). */
  topActors: Array<{ actorId: string; connections: number }>;
  maxConnections: number;
  maxConnectionsPerActor: number;
};

export class LiveBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly outboxPool: pg.Pool | null;
  private readonly maxConnectionsPerActor: number;
  private readonly maxConnections: number;
  private readonly sessionMaxAgeMs: number;
  private readonly drainIntervalMs: number;
  private readonly clients = new Set<WebSocket>();
  private readonly clientsByActor = new Map<string, number>();
  private subscribed = false;
  private closing = false;
  private publishFailures = 0;
  private outboxDepth = 0;
  private drainTimer: NodeJS.Timeout | null = null;
  private draining = false;
  /**
   * True while the subscriber connection has dropped since its last successful
   * subscribe: frames published in that window never reached connected
   * clients, so the next re-subscribe broadcasts a resync marker.
   */
  private subscriberGap = false;

  constructor(
    redisUrl: string,
    private readonly log: FastifyBaseLogger,
    options?: LiveBusOptions,
  ) {
    this.outboxPool = options?.outboxPool ?? null;
    this.maxConnectionsPerActor =
      options?.maxConnectionsPerActor ?? MAX_CONNECTIONS_PER_ACTOR;
    this.maxConnections = options?.maxConnections ?? MAX_CONNECTIONS;
    this.sessionMaxAgeMs = options?.sessionMaxAgeMs ?? SESSION_MAX_AGE_MS;
    this.drainIntervalMs = options?.drainIntervalMs ?? OUTBOX_DRAIN_INTERVAL_MS;
    const redisOptions = {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      connectTimeout: 5_000,
      keepAlive: 10_000,
      // Reconnect forever (the bus outlives transient Redis restarts) but cap
      // the backoff so recovery is prompt once Redis returns.
      retryStrategy: (attempt: number) => Math.min(attempt * 500, 5_000),
    };
    this.publisher =
      options?.publisher ?? new Redis(redisUrl, redisOptions);
    this.subscriber =
      options?.subscriber ?? new Redis(redisUrl, redisOptions);

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
    this.subscriber.on("close", () => {
      this.subscribed = false;
      this.subscriberGap = true;
    });
    this.subscriber.on("end", () => {
      this.subscribed = false;
      this.subscriberGap = true;
      if (this.closing) return;
      this.log.warn("Antifraud live subscriber redis connection ended");
    });
    this.subscriber.on("ready", () => {
      // ioredis only auto-resubscribes channels recorded by a SUCCESSFUL
      // subscribe, so re-issue it on every (re)connect. SUBSCRIBE is idempotent.
      void this.ensureSubscribed();
    });

    this.subscriber.on("message", (_channel: string, payload: string) => {
      this.broadcast(payload);
    });
  }

  private broadcast(payload: string): void {
    for (const client of this.clients) {
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.evict(client, 1013, "backpressure");
      } else if (client.readyState === client.OPEN) {
        try {
          client.send(payload, (error?: Error) => {
            if (error) this.evict(client, 1011, "send_failed");
          });
        } catch {
          this.evict(client, 1011, "send_failed");
        }
      }
    }
  }

  /**
   * Graceful eviction: a coded close frame so well-behaved clients back off
   * (1013) or report the fault (1011) instead of hot-retrying a 1006, with a
   * bounded terminate fallback for peers that never finish the handshake.
   */
  private evict(client: WebSocket, code: number, reason: string): void {
    try {
      client.close(code, reason);
    } catch {
      try {
        client.terminate();
      } catch {
        // The peer may already have completed teardown.
      }
      return;
    }
    const deadline = setTimeout(() => {
      try {
        client.terminate();
      } catch {
        // The peer may already have completed teardown.
      }
    }, EVICTION_TERMINATE_MS);
    deadline.unref();
    client.once("close", () => clearTimeout(deadline));
  }

  /**
   * Must complete before the process starts serving. A rejected subscribe fails
   * the boot so the platform restart policy retries instead of leaving the
   * service publishing into a channel with zero subscribers.
   */
  async start(): Promise<void> {
    await this.subscriber.subscribe(CHANNEL);
    this.subscribed = true;
    this.subscriberGap = false;
    if (this.outboxPool && !this.drainTimer) {
      this.drainTimer = setInterval(() => {
        void this.drainOutbox();
      }, this.drainIntervalMs);
      this.drainTimer.unref();
    }
  }

  /**
   * Total publishes that failed against Redis after the retry — surfaced on
   * /ready for alerting. With an outbox configured these frames were parked
   * durably instead of lost; without one they are gone.
   */
  get publishFailureCount(): number {
    return this.publishFailures;
  }

  stats(): LiveBusStats {
    const topActors = [...this.clientsByActor.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([actorId, connections]) => ({ actorId, connections }));
    return {
      subscribed: this.isSubscribed(),
      publishFailures: this.publishFailures,
      clients: this.clients.size,
      outboxDepth: this.outboxDepth,
      topActors,
      maxConnections: this.maxConnections,
      maxConnectionsPerActor: this.maxConnectionsPerActor,
    };
  }

  isSubscribed(): boolean {
    return (
      this.subscribed &&
      this.publisher.status === "ready" &&
      this.subscriber.status === "ready"
    );
  }

  private async ensureSubscribed(): Promise<void> {
    try {
      await this.subscriber.subscribe(CHANNEL);
      this.subscribed = true;
      if (this.subscriberGap) {
        this.subscriberGap = false;
        // Frames published while the subscriber was down never reached the
        // connected clients. Tell every client where the stream is NOW; the
        // SSE proxy intercepts type "resync" and replays the gap itself.
        await this.broadcastResync();
      }
    } catch (error) {
      this.subscribed = false;
      this.log.error(
        { err: error },
        "Failed to subscribe to the antifraud live channel",
      );
    }
  }

  async publish(
    type: LiveEventType,
    data: Record<string, unknown>,
    correlationId = randomUUID(),
  ): Promise<void> {
    if (!CORRELATION_ID_PATTERN.test(correlationId)) {
      throw new Error("Invalid antifraud live correlation id");
    }
    const message: LiveMessage = {
      schemaVersion: LIVE_SCHEMA_VERSION,
      correlationId,
      type,
      at: new Date().toISOString(),
      data,
    };
    const attempt = () =>
      this.publisher.eval(
        PUBLISH_SCRIPT,
        2,
        STREAM,
        CHANNEL,
        String(STREAM_MAX_LEN),
        JSON.stringify(message),
      );
    let id: unknown;
    try {
      id = await attempt();
    } catch (error) {
      // One bounded retry before falling back to the durable outbox (or, with
      // no outbox configured, before the event is permanently lost).
      this.log.warn(
        { err: error, liveEvent: type },
        "Antifraud live publish failed; retrying once",
      );
      await new Promise((resolve) =>
        setTimeout(resolve, PUBLISH_RETRY_DELAY_MS),
      );
      try {
        id = await attempt();
      } catch (retryError) {
        this.publishFailures += 1;
        if (!this.outboxPool) throw retryError;
        // Durable fallback: park the frame; the drain loop republishes it once
        // Redis returns. Ordering caveat: the drained frame gets a LATER
        // stream id than frames published live in the meantime, so replay-id
        // ordering across an outage window is eventual, not strict.
        await this.outboxPool.query(
          "INSERT INTO live_outbox(payload) VALUES ($1::jsonb)",
          [JSON.stringify(message)],
        );
        this.log.warn(
          { liveEvent: type },
          "Antifraud live publish parked in the outbox after Redis failure",
        );
        return;
      }
    }
    if (typeof id !== "string" || !STREAM_ID_PATTERN.test(id)) {
      this.publishFailures += 1;
      throw new Error("Redis returned an invalid antifraud live stream id");
    }
  }

  /**
   * One outbox drain pass, oldest rows first: republish through the same
   * atomic XADD+PUBLISH script, delete on success, stop the batch on the
   * first failure (Redis is evidently still down). Runs on a timer once
   * start() has an outbox pool; public so tests and operators can force a
   * pass. Never throws — drain problems are logged and retried next tick.
   */
  async drainOutbox(): Promise<void> {
    if (!this.outboxPool || this.draining || this.closing) return;
    this.draining = true;
    try {
      const pending = await this.outboxPool.query<{
        id: string;
        payload: Record<string, unknown>;
      }>(
        "SELECT id, payload FROM live_outbox ORDER BY id LIMIT $1",
        [OUTBOX_DRAIN_BATCH],
      );
      for (const row of pending.rows) {
        try {
          const id = await this.publisher.eval(
            PUBLISH_SCRIPT,
            2,
            STREAM,
            CHANNEL,
            String(STREAM_MAX_LEN),
            JSON.stringify(row.payload),
          );
          if (typeof id !== "string" || !STREAM_ID_PATTERN.test(id)) {
            throw new Error(
              "Redis returned an invalid antifraud live stream id",
            );
          }
        } catch {
          // Redis is still unavailable: keep the row and retry next tick.
          break;
        }
        await this.outboxPool.query(
          "DELETE FROM live_outbox WHERE id = $1",
          [row.id],
        );
      }
      const depth = await this.outboxPool.query<{ depth: number }>(
        "SELECT COUNT(*)::int AS depth FROM (SELECT 1 FROM live_outbox LIMIT $1) bounded",
        [OUTBOX_DEPTH_CAP],
      );
      this.outboxDepth = depth.rows[0]?.depth ?? 0;
    } catch (error) {
      this.log.error({ err: error }, "Antifraud live outbox drain failed");
    } finally {
      this.draining = false;
    }
  }

  /**
   * Gap marker for every connected client after the subscriber re-subscribes.
   * Not a catalogued live event: it never enters the stream, it only tells
   * the SSE proxy "you may have missed frames up to this id — replay them".
   */
  private async broadcastResync(): Promise<void> {
    if (this.clients.size === 0) return;
    this.broadcast(
      JSON.stringify({
        id: await this.streamTipId(),
        schemaVersion: LIVE_SCHEMA_VERSION,
        correlationId: "resync",
        type: "resync",
        at: new Date().toISOString(),
        data: { reason: "subscriber_gap" },
      }),
    );
  }

  /**
   * Bounded catch-up for a reconnecting client. `afterId` is the last id the
   * client saw (exclusive); omit it to get the most recent `limit` events.
   */
  async replay(afterId: string | null, limit: number): Promise<LiveReplayResult> {
    const count = Math.min(Math.max(limit, 1), REPLAY_MAX_ENTRIES);
    const entries: Array<[string, string[]]> = afterId
      ? await this.publisher.xrange(STREAM, afterId, "+", "COUNT", count + 1)
      : (
        await this.publisher.xrevrange(STREAM, "+", "-", "COUNT", count)
      ).reverse();

    let truncated = false;
    if (afterId) {
      const oldest = await this.publisher.xrange(STREAM, "-", "+", "COUNT", 1);
      const oldestId = oldest[0]?.[0];
      // An empty stream also means the caller's cursor no longer resolves to a
      // retained entry: treat it as trimmed so the client resyncs.
      truncated = !oldestId || compareStreamIds(afterId, oldestId) < 0;
    }

    let cursor: string | null = null;
    const messages: LiveEnvelope[] = [];
    for (const [id, fields] of entries) {
      if (afterId && id === afterId) continue;
      cursor = id;
      const index = fields.indexOf("payload");
      const raw = index >= 0 ? fields[index + 1] : undefined;
      const message = raw ? parseEnvelope(id, raw) : null;
      if (message) messages.push(message);
      if (messages.length === count) break;
    }
    return { events: messages, cursor, truncated };
  }

  addClient(client: WebSocket, actorId: string): boolean {
    // The upgrade handler awaits a Redis round-trip before registering the
    // socket; a peer that disconnected in that window has already emitted its
    // `close` event, so registering it now would leak the slot forever.
    if (client.readyState !== client.OPEN) return false;
    const actorConnections = this.clientsByActor.get(actorId) ?? 0;
    if (
      actorConnections >= this.maxConnectionsPerActor ||
      this.clients.size >= this.maxConnections
    ) {
      return false;
    }

    this.clients.add(client);
    this.clientsByActor.set(actorId, actorConnections + 1);
    let released = false;
    let alive = true;
    const terminate = () => {
      try {
        client.terminate();
      } catch {
        // The peer may already have completed teardown.
      }
    };
    // Idempotent slot/timer release: every teardown path funnels through here
    // so a socket that never emits `close` cannot leak its heartbeat or quota.
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      this.clients.delete(client);
      const remaining = (this.clientsByActor.get(actorId) ?? 1) - 1;
      if (remaining <= 0) this.clientsByActor.delete(actorId);
      else this.clientsByActor.set(actorId, remaining);
    };
    // Absolute lifetime: 1012 (service restart) tells the proxy to reconnect,
    // which forces a fresh ticket and therefore fresh authorization.
    const lifetime = setTimeout(() => {
      this.evict(client, 1012, "reauth");
    }, this.sessionMaxAgeMs);
    lifetime.unref();
    const heartbeat = setInterval(() => {
      if (client.readyState !== client.OPEN) {
        release();
        terminate();
        return;
      }
      if (!alive) {
        terminate();
        return;
      }
      alive = false;
      try {
        client.ping();
      } catch {
        terminate();
      }
    }, HEARTBEAT_MS);
    client.on("pong", () => {
      alive = true;
    });
    client.on("error", (error: Error) => {
      this.log.warn(
        { err: error, actorId },
        "Antifraud live websocket client error",
      );
      this.evict(client, 1011, "client_error");
      release();
    });
    client.on("close", release);
    void this.sendConnectedFrame(client);
    return true;
  }

  /**
   * Handshake frame carrying the stream tip as a valid resume cursor, so a
   * client that connects during a quiet period can still replay from a real
   * stream id after its next reconnect ("0-0" when the stream is empty).
   */
  /** Current stream tip id, "0-0" when the stream is empty or unreadable. */
  private async streamTipId(): Promise<string> {
    try {
      const tip = await this.publisher.xrevrange(STREAM, "+", "-", "COUNT", 1);
      const id = tip[0]?.[0];
      if (typeof id === "string" && STREAM_ID_PATTERN.test(id)) return id;
    } catch (error) {
      this.log.warn(
        { err: error },
        "Antifraud live stream tip lookup failed; falling back to 0-0",
      );
    }
    return "0-0";
  }

  private async sendConnectedFrame(client: WebSocket): Promise<void> {
    const tipId = await this.streamTipId();
    if (client.readyState !== client.OPEN) return;
    client.send(
      JSON.stringify({
        id: tipId,
        schemaVersion: LIVE_SCHEMA_VERSION,
        correlationId: randomUUID(),
        type: "connected",
        at: new Date().toISOString(),
        data: {},
      }),
      (error?: Error) => {
        if (error) this.evict(client, 1011, "send_failed");
      },
    );
  }

  async createTicket(actor: Record<string, unknown>): Promise<string> {
    for (let attempt = 0; attempt < TICKET_CREATE_ATTEMPTS; attempt += 1) {
      const ticket = randomBytes(32).toString("base64url");
      const result = await this.publisher.set(
        `antifraud:ws-ticket:${ticket}`,
        JSON.stringify(actor),
        "EX",
        TICKET_TTL_SECONDS,
        "NX",
      );
      if (result === "OK") return ticket;
    }
    throw new Error("Failed to reserve a unique antifraud websocket ticket");
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
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    // Terminate backstop: the websocket plugin's preClose already offered every
    // client a graceful close(1001); anything still registered here is either
    // unresponsive or was never covered, so force it down before Redis quits.
    for (const client of this.clients) {
      try {
        client.close(1001, "server_shutdown");
      } catch {
        // The peer may already have completed teardown.
      }
      try {
        client.terminate();
      } catch {
        // The peer may already have completed teardown.
      }
    }
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
