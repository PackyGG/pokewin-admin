import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type pg from "pg";

import { serviceRequestAuthorized } from "../src/auth.js";
import { LiveBus } from "../src/live.js";
import { createPromiseCache } from "../src/promise-cache.js";
import { defaultScoreWeights } from "../src/score-catalog.js";
import {
  ScoreWeightStaleError,
  ScoreWeightStore,
} from "../src/score-weight-store.js";
import { createFixedWindowIpLimiter } from "../src/transport-limits.js";

const quietLogger = {
  error() {},
  warn() {},
} as unknown as FastifyBaseLogger;

// ---------------------------------------------------------------------------
// ScoreWeightStore
// ---------------------------------------------------------------------------

type FakeQuery = (sql: string, values?: unknown[]) => Promise<{
  rows: unknown[];
  rowCount?: number;
}>;

function fakePool(clientQuery: FakeQuery, poolQuery?: FakeQuery): pg.Pool {
  return {
    async connect() {
      return {
        query: clientQuery,
        release() {},
      };
    },
    query: poolQuery ?? clientQuery,
  } as unknown as pg.Pool;
}

test("score weight update upserts a catalog key without a seeded row", async () => {
  const statements: string[] = [];
  const auditValues: unknown[][] = [];
  const updatedAt = new Date("2026-07-30T10:00:00.000Z");
  const store = new ScoreWeightStore(fakePool(async (sql, values) => {
    statements.push(sql);
    if (sql.includes("service_audit_events") && sql.startsWith("SELECT")) {
      return { rows: [] };
    }
    if (sql.includes("FOR UPDATE")) return { rows: [] };
    if (sql.startsWith("INSERT INTO score_weights")) {
      assert.match(sql, /ON CONFLICT \(key\) DO UPDATE/);
      return {
        rows: [{ key: "fiat_deposit", points: 33, updated_at: updatedAt }],
      };
    }
    if (sql.startsWith("INSERT INTO service_audit_events")) {
      auditValues.push(values ?? []);
      return { rows: [] };
    }
    if (sql.includes("FROM score_weights")) {
      return {
        rows: [{ key: "fiat_deposit", points: 33, updated_at: updatedAt }],
      };
    }
    return { rows: [] };
  }));

  const result = await store.update({
    key: "fiat_deposit",
    points: 33,
    actorId: "admin-1",
    actorUsername: "packy",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  });

  assert.deepEqual(result, {
    key: "fiat_deposit",
    points: 33,
    updatedAt: updatedAt.toISOString(),
    idempotent: false,
  });
  // The idempotency key is serialized before any table read.
  assert.match(statements[1] ?? "", /pg_advisory_xact_lock/);
  // before_state falls back to the catalog default when no row existed.
  const beforeState = JSON.parse(String(auditValues[0]?.[5]));
  assert.equal(beforeState.points, defaultScoreWeights().fiat_deposit);
  assert.equal(beforeState.source, "catalog_default");
});

test("a stale expectedUpdatedAt rejects with the current timestamp", async () => {
  const current = new Date("2026-07-01T00:00:00.000Z");
  let rolledBack = false;
  const store = new ScoreWeightStore(fakePool(async (sql) => {
    if (sql === "ROLLBACK") rolledBack = true;
    if (sql.includes("service_audit_events") && sql.startsWith("SELECT")) {
      return { rows: [] };
    }
    if (sql.includes("FOR UPDATE")) {
      return { rows: [{ key: "fiat_deposit", points: 20, updated_at: current }] };
    }
    return { rows: [] };
  }));

  await assert.rejects(
    store.update({
      key: "fiat_deposit",
      points: 25,
      actorId: "admin-1",
      actorUsername: null,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      expectedUpdatedAt: "2026-07-02T00:00:00.000Z",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScoreWeightStaleError);
      assert.equal(error.currentUpdatedAt, current.toISOString());
      return true;
    },
  );
  assert.ok(rolledBack);
});

test("a matching expectedUpdatedAt lets the update proceed", async () => {
  const current = new Date("2026-07-01T00:00:00.000Z");
  const after = new Date("2026-07-03T00:00:00.000Z");
  const store = new ScoreWeightStore(fakePool(async (sql) => {
    if (sql.includes("service_audit_events") && sql.startsWith("SELECT")) {
      return { rows: [] };
    }
    if (sql.includes("FOR UPDATE")) {
      return { rows: [{ key: "fiat_deposit", points: 20, updated_at: current }] };
    }
    if (sql.startsWith("INSERT INTO score_weights")) {
      return { rows: [{ key: "fiat_deposit", points: 25, updated_at: after }] };
    }
    if (sql.includes("FROM score_weights")) {
      return { rows: [{ key: "fiat_deposit", points: 25, updated_at: after }] };
    }
    return { rows: [] };
  }));

  const result = await store.update({
    key: "fiat_deposit",
    points: 25,
    actorId: "admin-1",
    actorUsername: null,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    expectedUpdatedAt: current.toISOString(),
  });
  assert.equal(result.points, 25);
  assert.equal(result.idempotent, false);
});

test("a unique violation re-enters the idempotent replay path", async () => {
  const updatedAt = new Date("2026-07-30T10:00:00.000Z");
  let auditLookups = 0;
  const store = new ScoreWeightStore(fakePool(async (sql) => {
    if (sql.includes("service_audit_events") && sql.startsWith("SELECT")) {
      auditLookups += 1;
      // First lookup misses (the concurrent writer had not committed yet);
      // after the 23505 the committed row is visible.
      if (auditLookups === 1) return { rows: [] };
      return {
        rows: [{
          target_id: "fiat_deposit",
          actor_id: "admin-1",
          actor_username: null,
          request_state: { key: "fiat_deposit", points: 33 },
        }],
      };
    }
    if (sql.includes("FOR UPDATE")) return { rows: [] };
    if (sql.startsWith("INSERT INTO score_weights")) {
      return {
        rows: [{ key: "fiat_deposit", points: 33, updated_at: updatedAt }],
      };
    }
    if (sql.startsWith("INSERT INTO service_audit_events")) {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    }
    if (sql.includes("FROM score_weights")) {
      return {
        rows: [{ key: "fiat_deposit", points: 33, updated_at: updatedAt }],
      };
    }
    return { rows: [] };
  }));

  const result = await store.update({
    key: "fiat_deposit",
    points: 33,
    actorId: "admin-1",
    actorUsername: null,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.points, 33);
});

test("getUpdatedAt exposes timestamps only for stored rows", async () => {
  const updatedAt = new Date("2026-07-30T10:00:00.000Z");
  const store = new ScoreWeightStore(fakePool(async () => ({
    rows: [{ key: "fiat_deposit", points: 33, updated_at: updatedAt }],
  })));

  const timestamps = await store.getUpdatedAt();
  assert.equal(timestamps.fiat_deposit, updatedAt.toISOString());
  assert.equal(timestamps.crypto_deposit, undefined);
});

// ---------------------------------------------------------------------------
// Promise cache stale-on-error
// ---------------------------------------------------------------------------

test("promise cache rejections still propagate without stale-on-error", async () => {
  let clock = 0;
  let fail = false;
  let loads = 0;
  const cached = createPromiseCache<string, number>(
    async () => {
      loads += 1;
      if (fail) throw new Error("boom");
      return 7;
    },
    100,
    () => clock,
  );

  assert.equal(await cached("k"), 7);
  clock = 200;
  fail = true;
  await assert.rejects(cached("k"), /boom/);
  assert.equal(loads, 2);
});

test("promise cache serves the last good value during the error window", async () => {
  let clock = 0;
  let fail = false;
  let loads = 0;
  const cached = createPromiseCache<string, number>(
    async () => {
      loads += 1;
      if (fail) throw new Error("boom");
      return 7;
    },
    100,
    () => clock,
    { staleOnErrorMs: 30 },
  );

  assert.equal(await cached("k"), 7);
  clock = 200;
  fail = true;
  // The failed refresh degrades to the last good value…
  assert.equal(await cached("k"), 7);
  const loadsAfterFailure = loads;
  // …and the stale value is parked: no upstream storm inside the window.
  clock = 210;
  assert.equal(await cached("k"), 7);
  assert.equal(loads, loadsAfterFailure);
  // Past the window a real refresh is attempted again.
  clock = 300;
  fail = false;
  assert.equal(await cached("k"), 7);
  assert.equal(loads, loadsAfterFailure + 1);
});

// ---------------------------------------------------------------------------
// Ticket IP floor
// ---------------------------------------------------------------------------

test("the fixed-window IP limiter caps a source regardless of body identity", () => {
  let clock = 0;
  const allows = createFixedWindowIpLimiter(2, 60_000, () => clock);
  assert.equal(allows("198.51.100.7"), true);
  assert.equal(allows("198.51.100.7"), true);
  assert.equal(allows("198.51.100.7"), false);
  // Other IPs keep their own budget.
  assert.equal(allows("198.51.100.8"), true);
  // The window resets.
  clock = 60_001;
  assert.equal(allows("198.51.100.7"), true);
});

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

test("live transport observability requires the admin token", () => {
  const config = { API_TOKEN: "read-token-1234", API_ADMIN_TOKEN: "admin-token-1234" };
  assert.equal(
    serviceRequestAuthorized("GET", "/v1/operations/live", "read-token-1234", config),
    false,
  );
  assert.equal(
    serviceRequestAuthorized("GET", "/v1/operations/live", "admin-token-1234", config),
    true,
  );
  // The poller route stays readable with the read token.
  assert.equal(
    serviceRequestAuthorized("GET", "/v1/operations/poller", "read-token-1234", config),
    true,
  );
});

// ---------------------------------------------------------------------------
// Live replay: scanned + ahead-of-tip cursors
// ---------------------------------------------------------------------------

type StreamEntry = [string, string[]];

class FakeRedis extends EventEmitter {
  status = "ready";
  entries: StreamEntry[] = [];

  async subscribe(): Promise<number> {
    return 1;
  }

  async eval(): Promise<string> {
    return "1720000000000-1";
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
      .filter(([id]) => {
        if (from === null) return true;
        const [fromMs = 0, fromSeq = 0] = from.split("-").map(Number);
        const [ms = 0, seq = 0] = id.split("-").map(Number);
        return ms > fromMs || (ms === fromMs && seq >= fromSeq);
      })
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
    return "OK";
  }
}

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

test("replay reports scanned entries so parse-skips are visible", async () => {
  const { bus, redis } = liveBusFixture();
  redis.entries = [
    envelope("1-1"),
    ["1-2", ["payload", "not-json"]],
    envelope("1-3"),
  ];

  const result = await bus.replay(null, 10);
  assert.equal(result.scanned, 3);
  assert.equal(result.events.length, 2);
  assert.equal(result.cursor, "1-3");
  assert.equal(result.truncated, false);
});

test("a cursor newer than the stream tip is treated as truncated", async () => {
  const { bus, redis } = liveBusFixture();
  redis.entries = [envelope("5-1")];

  const result = await bus.replay("9-9", 10);
  assert.equal(result.truncated, true);
  assert.equal(result.events.length, 0);
  assert.equal(result.scanned, 0);
});

test("frame listeners observe catalogued bus frames", async () => {
  const { bus, redis } = liveBusFixture();
  const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
  bus.onFrame((type, data) => seen.push({ type, data }));

  redis.emit(
    "message",
    "antifraud:live",
    JSON.stringify({
      id: "1-1",
      schemaVersion: 1,
      correlationId: "corr-1",
      type: "score_weight.updated",
      at: "2026-01-01T00:00:00.000Z",
      data: { key: "fiat_deposit", points: 33 },
    }),
  );
  redis.emit("message", "antifraud:live", "not-json");
  redis.emit(
    "message",
    "antifraud:live",
    JSON.stringify({ type: "resync", data: {} }),
  );
  await delay(0);

  assert.deepEqual(seen, [
    {
      type: "score_weight.updated",
      data: { key: "fiat_deposit", points: 33 },
    },
  ]);
});

// ---------------------------------------------------------------------------
// Route source contracts (no HTTP harness exists; follow audit-contracts.ts)
// ---------------------------------------------------------------------------

test("hardened route behaviors stay wired in server.ts", async () => {
  const server = await readFile(
    new URL("../src/server.ts", import.meta.url),
    "utf8",
  );

  // Idempotency retries serialize on an advisory transaction lock and unique
  // violations resolve as replays instead of 500s.
  assert.match(server, /pg_advisory_xact_lock\(hashtextextended/);
  assert.ok(server.split("takeAdvisoryTxLock(client, body.idempotencyKey)").length >= 4);
  assert.ok(server.split("UNIQUE_VIOLATION").length >= 4);
  // Failed transactions must surface the ORIGINAL error, not the rollback's.
  assert.ok(
    server.split('await client.query("ROLLBACK").catch(() => undefined)')
      .length >= 4,
  );
  // Decision double-submits replay from INSIDE the case row lock.
  assert.match(server, /const inLock = await resolveReplay\(client\);/);
  // Escalated cases are not silently de-escalated by an in_review decision.
  assert.match(server, /row\.status === "escalated"\s*\?\s*"escalated"/);
  // Decisions leave a durable audit row alongside the cascading staff action.
  assert.match(server, /'case\.decision','case'/);
  // Optimistic-concurrency conflicts answer with the current timestamp.
  assert.match(server, /error: "stale_rule"/);
  assert.match(server, /error: "stale_weight"/);
  // Rule creation is bounded and de-duplicated.
  assert.match(server, /error: "rule_limit_reached"/);
  assert.match(server, /error: "duplicate_rule"/);
  // Probes bypass the limiter; unseen-count windows are bounded server-side.
  assert.ok(server.split("config: { rateLimit: false }").length >= 3);
  assert.match(server, /window must not exceed 31 days/);
  assert.match(server, /first_seen_at > \$1::timestamptz/);
  // Scoring changes broadcast a live frame like rules already do.
  assert.match(server, /publishCommittedMutation\("score_weight\.updated"/);
});
