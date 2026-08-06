import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { WebSocket } from "ws";

import { LiveBus, type LiveBusOptions } from "../src/live.js";

type StreamEntry = [string, string[]];

class FakeRedis extends EventEmitter {
  status = "ready";
  entries: StreamEntry[] = [];
  evalResults: Array<string | Error> = [];
  evalPayloads: string[] = [];
  evalCalls = 0;
  quitCalls = 0;

  async subscribe(): Promise<number> {
    return 1;
  }

  async eval(...args: unknown[]): Promise<string> {
    this.evalCalls += 1;
    this.evalPayloads.push(String(args[5]));
    const next = this.evalResults.shift() ?? "1720000000000-1";
    if (next instanceof Error) throw next;
    return next;
  }

  async xrevrange(
    _stream: string,
    _start: string,
    _end: string,
    _countKeyword: string,
    count: number,
  ): Promise<StreamEntry[]> {
    return [...this.entries].reverse().slice(0, count);
  }

  async quit(): Promise<"OK"> {
    this.quitCalls += 1;
    return "OK";
  }
}

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  terminated = 0;
  closes: Array<{ code?: number; reason?: string }> = [];
  sent: string[] = [];

  send(payload: string, callback?: (error?: Error) => void): void {
    this.sent.push(payload);
    callback?.();
  }

  ping(): void {}

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.finish();
  }

  terminate(): void {
    this.terminated += 1;
    this.finish();
  }

  private finish(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit("close");
  }
}

/** In-memory stand-in for the live_outbox table behind a pg.Pool. */
class FakeOutboxPool {
  rows: Array<{ id: string; payload: Record<string, unknown> }> = [];
  insertErrors: Error[] = [];
  private nextId = 1;

  async query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[] }> {
    if (sql.includes("INSERT INTO live_outbox")) {
      const failure = this.insertErrors.shift();
      if (failure) throw failure;
      this.rows.push({
        id: String(this.nextId++),
        payload: JSON.parse(String(values?.[0])) as Record<string, unknown>,
      });
      return { rows: [] };
    }
    if (sql.includes("SELECT id, payload FROM live_outbox")) {
      return { rows: this.rows.slice(0, Number(values?.[0])) };
    }
    if (sql.includes("DELETE FROM live_outbox")) {
      this.rows = this.rows.filter((row) => row.id !== values?.[0]);
      return { rows: [] };
    }
    if (sql.includes("COUNT(*)::int AS depth")) {
      return {
        rows: [{ depth: Math.min(this.rows.length, Number(values?.[0])) }],
      };
    }
    throw new Error(`Unexpected outbox SQL: ${sql}`);
  }
}

const quietLogger = {
  error() {},
  warn() {},
} as unknown as FastifyBaseLogger;

function fixture(options?: Partial<LiveBusOptions> & { pool?: FakeOutboxPool }) {
  const redis = new FakeRedis();
  const pool = options?.pool ?? new FakeOutboxPool();
  const bus = new LiveBus("redis://fixture", quietLogger, {
    publisher: redis as unknown as Redis,
    subscriber: redis as unknown as Redis,
    outboxPool: pool as unknown as pg.Pool,
    ...options,
  });
  return { bus, redis, pool };
}

test("publish parks the frame in the outbox when Redis stays down", async () => {
  const { bus, redis, pool } = fixture();
  redis.evalResults = [new Error("redis gone"), new Error("still gone")];

  await bus.publish("monitor.event", { caseId: "case-1" });

  assert.equal(redis.evalCalls, 2);
  assert.equal(bus.stats().publishFailures, 1);
  assert.equal(pool.rows.length, 1);
  const parked = pool.rows[0]?.payload ?? {};
  assert.equal(parked.type, "monitor.event");
  assert.deepEqual(parked.data, { caseId: "case-1" });
  await bus.close();
});

test("publish still rejects when the outbox insert itself fails", async () => {
  const { bus, redis, pool } = fixture();
  redis.evalResults = [new Error("redis gone"), new Error("still gone")];
  pool.insertErrors = [new Error("outbox down")];

  await assert.rejects(
    bus.publish("monitor.event", { caseId: "case-1" }),
    /outbox down/,
  );
  assert.equal(pool.rows.length, 0);
  await bus.close();
});

test("drain republishes parked frames oldest-first and deletes them", async () => {
  const { bus, redis, pool } = fixture();
  redis.evalResults = [new Error("gone"), new Error("gone"), new Error("gone"), new Error("gone")];
  await bus.publish("monitor.event", { seq: 1 });
  await bus.publish("case.decided", { seq: 2 });
  assert.equal(pool.rows.length, 2);

  redis.evalResults = ["1720000000000-9", "1720000000000-10"];
  await bus.drainOutbox();

  assert.equal(pool.rows.length, 0);
  assert.equal(bus.stats().outboxDepth, 0);
  const republished = redis.evalPayloads
    .slice(-2)
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
  assert.deepEqual(
    republished.map((message) => message.data),
    [{ seq: 1 }, { seq: 2 }],
  );
  await bus.close();
});

test("drain stops the batch on the first Redis failure and keeps the rows", async () => {
  const { bus, redis, pool } = fixture();
  redis.evalResults = [new Error("gone"), new Error("gone"), new Error("gone"), new Error("gone")];
  await bus.publish("monitor.event", { seq: 1 });
  await bus.publish("monitor.event", { seq: 2 });

  redis.evalResults = [new Error("still gone")];
  await bus.drainOutbox();

  assert.equal(pool.rows.length, 2);
  assert.equal(bus.stats().outboxDepth, 2);
  await bus.close();
});

test("subscriber reconnect broadcasts one resync frame with the stream tip", async () => {
  const { bus, redis } = fixture();
  redis.entries = [
    ["1720000000000-7", ["payload", "{}"]],
  ];
  const client = new FakeWebSocket();
  assert.equal(bus.addClient(client as unknown as WebSocket, "staff-1"), true);
  await delay(0);

  redis.emit("close");
  redis.emit("ready");
  await delay(5);

  const resync = client.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .find((frame) => frame.type === "resync");
  assert.ok(resync, "expected a resync frame after the subscriber gap");
  assert.equal(resync.id, "1720000000000-7");
  assert.equal(resync.schemaVersion, 1);
  assert.equal(resync.correlationId, "resync");
  assert.deepEqual(resync.data, { reason: "subscriber_gap" });

  // A ready without a preceding gap must not broadcast again.
  redis.emit("ready");
  await delay(5);
  const resyncCount = client.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === "resync").length;
  assert.equal(resyncCount, 1);
  await bus.close();
});

test("sessions past their absolute lifetime close with 1012 reauth", async () => {
  const { bus } = fixture({ sessionMaxAgeMs: 20 });
  const client = new FakeWebSocket();
  assert.equal(bus.addClient(client as unknown as WebSocket, "staff-1"), true);

  await delay(60);

  assert.deepEqual(client.closes, [{ code: 1012, reason: "reauth" }]);
  // The lifetime close released the slot, so the actor can reconnect.
  const replacement = new FakeWebSocket();
  assert.equal(
    bus.addClient(replacement as unknown as WebSocket, "staff-1"),
    true,
  );
  await bus.close();
});

test("connection caps are configurable and surfaced in stats", async () => {
  const { bus } = fixture({ maxConnectionsPerActor: 1, maxConnections: 2 });
  const first = new FakeWebSocket();
  const second = new FakeWebSocket();
  const third = new FakeWebSocket();
  const fourth = new FakeWebSocket();

  assert.equal(bus.addClient(first as unknown as WebSocket, "staff-1"), true);
  assert.equal(bus.addClient(second as unknown as WebSocket, "staff-1"), false);
  assert.equal(bus.addClient(third as unknown as WebSocket, "staff-2"), true);
  assert.equal(bus.addClient(fourth as unknown as WebSocket, "staff-3"), false);

  const stats = bus.stats();
  assert.equal(stats.clients, 2);
  assert.equal(stats.maxConnectionsPerActor, 1);
  assert.equal(stats.maxConnections, 2);
  assert.deepEqual(
    [...stats.topActors].sort((a, b) => a.actorId.localeCompare(b.actorId)),
    [
      { actorId: "staff-1", connections: 1 },
      { actorId: "staff-2", connections: 1 },
    ],
  );
  await bus.close();
});
