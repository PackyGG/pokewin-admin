import { randomBytes } from "node:crypto";

import { Redis } from "ioredis";
import type { WebSocket } from "ws";

import type { LiveMessage } from "./types.js";

const CHANNEL = "antifraud:live";
const MAX_BUFFERED_BYTES = 512 * 1024;
const HEARTBEAT_MS = 30_000;

export class LiveBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly clients = new Set<WebSocket>();
  private readonly clientsByActor = new Map<string, number>();

  constructor(redisUrl: string) {
    this.publisher = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    this.subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    this.subscriber.subscribe(CHANNEL).catch(() => undefined);
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

  async publish(type: string, data: Record<string, unknown>): Promise<void> {
    const message: LiveMessage = {
      type,
      at: new Date().toISOString(),
      data,
    };
    await this.publisher.publish(CHANNEL, JSON.stringify(message));
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
      type: "connected",
      at: new Date().toISOString(),
      data: {},
    } satisfies LiveMessage));
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
    for (const client of this.clients) client.close(1001, "Server shutdown");
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
