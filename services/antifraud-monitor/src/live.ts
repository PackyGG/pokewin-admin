import { randomBytes } from "node:crypto";

import { Redis } from "ioredis";
import type { WebSocket } from "ws";

import type { LiveMessage } from "./types.js";

const CHANNEL = "antifraud:live";

export class LiveBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly clients = new Set<WebSocket>();

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
        if (client.readyState === client.OPEN) client.send(payload);
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

  addClient(client: WebSocket): void {
    this.clients.add(client);
    client.on("close", () => this.clients.delete(client));
    client.send(JSON.stringify({
      type: "connected",
      at: new Date().toISOString(),
      data: {},
    } satisfies LiveMessage));
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

  async consumeTicket(ticket: string): Promise<boolean> {
    const key = `antifraud:ws-ticket:${ticket}`;
    const result = await this.publisher.call("GETDEL", key);
    return typeof result === "string";
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.close(1001, "Server shutdown");
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
