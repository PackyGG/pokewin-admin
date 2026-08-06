import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";

import { compareStreamIds, LiveBus } from "../src/live.js";

type StreamEntry = [string, string[]];

class FakeRedis extends EventEmitter {
  status = "ready";
  entries: StreamEntry[] = [];
  evalResults: Array<string | Error> = [];
  evalCalls = 0;
  quitCalls = 0;

  async subscribe(): Promise<number> {
    return 1;
  }

  async eval(): Promise<string> {
    this.evalCalls += 1;
    const next = this.evalResults.shift() ?? "1720000000000-1";
    if (next instanceof Error) throw next;
    return next;
  }

  async xrange(
    _stream: string,
    start: string,
    _end: string,
    _countKeyword: string,
    count: number,
  ): Promise<StreamEntry[]> {
    const from = start === "-" ? null : start;
    return this.entries
      .filter(([id]) => from === null || compareStreamIds(id, from) >= 0)
      .slice(0, count);
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

const quietLogger = {
  error() {},
  warn() {},
} as unknown as FastifyBaseLogger;

function liveBusFixture(): { bus: LiveBus; redis: FakeRedis } {
  const redis = new FakeRedis();
  const bus = new LiveBus("redis://fixture", quietLogger, {
    publisher: redis as unknown as Redis,
    subscriber: redis as unknown as Redis,
  });
  return { bus, redis };
}

function envelope(id: string, type = "monitor.event"): StreamEntry {
  return [
    id,
    [
      "payload",
      JSON.stringify({
        schemaVersion: 1,
        correlationId: "corr-1",
        type,
        at: "2026-01-01T00:00:00.000Z",
        data: {},
      }),
    ],
  ];
}

test("stream id comparison orders ms then sequence numerically", () => {
  assert.equal(compareStreamIds("2-0", "10-0"), -1);
  assert.equal(compareStreamIds("10-2", "10-10"), -1);
  assert.equal(compareStreamIds("10-10", "10-10"), 0);
  assert.equal(compareStreamIds("11-0", "10-99"), 1);
});

test("addClient refuses a socket that closed during the ticket round-trip", async () => {
  const { bus } = liveBusFixture();
  const client = new FakeWebSocket();
  client.readyState = 3;

  assert.equal(bus.addClient(client as unknown as WebSocket, "staff-1"), false);

  // The refused socket must not consume the actor slot.
  const replacement = new FakeWebSocket();
  assert.equal(
    bus.addClient(replacement as unknown as WebSocket, "staff-1"),
    true,
  );
  await bus.close();
});

test("connected frame carries the stream tip id as a resume cursor", async () => {
  const { bus, redis } = liveBusFixture();
  redis.entries = [envelope("1720000000000-1"), envelope("1720000000000-5")];
  const client = new FakeWebSocket();

  assert.equal(bus.addClient(client as unknown as WebSocket, "staff-1"), true);
  await delay(0);

  const frame = JSON.parse(client.sent[0] ?? "{}") as Record<string, unknown>;
  assert.equal(frame.type, "connected");
  assert.equal(frame.id, "1720000000000-5");
  await bus.close();
});

test("connected frame carries an empty id when the stream is empty", async () => {
  // NOT "0-0": that would become a resume cursor that replays the entire
  // retained stream and reads as truncated forever. An empty id fails the
  // consumer's replay-id check, which correctly means "no cursor yet".
  const { bus } = liveBusFixture();
  const client = new FakeWebSocket();

  assert.equal(bus.addClient(client as unknown as WebSocket, "staff-1"), true);
  await delay(0);

  const frame = JSON.parse(client.sent[0] ?? "{}") as Record<string, unknown>;
  assert.equal(frame.id, "");
  await bus.close();
});

test("replay cursor advances past unparseable entries", async () => {
  const { bus, redis } = liveBusFixture();
  redis.entries = [
    envelope("1720000000000-1"),
    ["1720000000000-2", ["payload", "{corrupt"]],
    ["1720000000000-3", ["payload", "{corrupt"]],
  ];

  const result = await bus.replay("1720000000000-1", 200);

  assert.equal(result.events.length, 0);
  // The cursor is the last SCANNED id so the caller's next page starts after
  // the corrupt tail instead of looping on it forever.
  assert.equal(result.cursor, "1720000000000-3");
  assert.equal(result.truncated, false);
  await bus.close();
});

test("replay flags truncation when the cursor predates the retained stream", async () => {
  const { bus, redis } = liveBusFixture();
  redis.entries = [envelope("1720000000000-10")];

  const trimmed = await bus.replay("1719000000000-1", 200);
  assert.equal(trimmed.truncated, true);
  assert.equal(trimmed.events.length, 1);

  const current = await bus.replay("1720000000000-10", 200);
  assert.equal(current.truncated, false);

  redis.entries = [];
  const empty = await bus.replay("1719000000000-1", 200);
  assert.equal(empty.truncated, true);
  await bus.close();
});

test("publish retries once and counts sustained failures", async () => {
  const { bus, redis } = liveBusFixture();
  redis.evalResults = [new Error("redis gone"), "1720000000000-2"];

  await bus.publish("monitor.event", { caseId: "case-1" });
  assert.equal(redis.evalCalls, 2);
  assert.equal(bus.stats().publishFailures, 0);

  redis.evalResults = [new Error("redis gone"), new Error("still gone")];
  await assert.rejects(
    bus.publish("monitor.event", { caseId: "case-1" }),
    /still gone/,
  );
  assert.equal(redis.evalCalls, 4);
  assert.equal(bus.stats().publishFailures, 1);
  await bus.close();
});

test("backpressure evicts with close code 1013 instead of a bare terminate", async () => {
  const { bus, redis } = liveBusFixture();
  const client = new FakeWebSocket();
  assert.equal(bus.addClient(client as unknown as WebSocket, "staff-1"), true);

  client.bufferedAmount = 10 * 1024 * 1024;
  redis.emit("message", "antifraud:live", "{}");

  assert.deepEqual(client.closes, [{ code: 1013, reason: "backpressure" }]);
  assert.equal(client.terminated, 0);
  await bus.close();
});

test("a backpressured client is evicted once, not on every frame", async () => {
  const { bus, redis } = liveBusFixture();
  const client = new FakeWebSocket();
  assert.equal(bus.addClient(client as unknown as WebSocket, "staff-1"), true);
  const listenersBefore = client.listenerCount("close");

  client.bufferedAmount = 10 * 1024 * 1024;
  // A broadcast storm: every frame used to re-evict the same socket, because
  // bufferedAmount was tested BEFORE readyState and evict() had no idempotence
  // guard — so each frame allocated a fresh terminate timer and registered
  // another `close` listener, tripping MaxListenersExceededWarning.
  for (let i = 0; i < 25; i += 1) {
    redis.emit("message", "antifraud:live", "{}");
  }

  assert.deepEqual(client.closes, [{ code: 1013, reason: "backpressure" }]);
  assert.equal(client.terminated, 0);
  assert.ok(
    client.listenerCount("close") - listenersBefore <= 1,
    `evict registered ${client.listenerCount("close") - listenersBefore} close listeners`,
  );
  await bus.close();
});

test("a still-open client keeps receiving frames after a peer is evicted", async () => {
  const { bus, redis } = liveBusFixture();
  const stuck = new FakeWebSocket();
  const healthy = new FakeWebSocket();
  assert.equal(bus.addClient(stuck as unknown as WebSocket, "staff-1"), true);
  assert.equal(bus.addClient(healthy as unknown as WebSocket, "staff-2"), true);
  const healthyBefore = healthy.sent.length;

  stuck.bufferedAmount = 10 * 1024 * 1024;
  redis.emit("message", "antifraud:live", '{"type":"monitor.event"}');
  redis.emit("message", "antifraud:live", '{"type":"monitor.event"}');

  assert.equal(stuck.closes.length, 1);
  assert.equal(healthy.sent.length - healthyBefore, 2);
  await bus.close();
});
