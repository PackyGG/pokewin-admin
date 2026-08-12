import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Config } from "../../services/antifraud-monitor/src/config.js";
import { IngestDelivery } from "../../services/antifraud-monitor/src/ingest-delivery.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

const config = {
  ANTIFRAUD_INGEST_URL: "https://fraud.packydash.com/api/antifraud/ingest",
  ANTIFRAUD_INGEST_SECRET: "s".repeat(64),
} as Config;

const quietLogger = {
  warn() {},
  error() {},
} as unknown as FastifyBaseLogger;

type ProbePool = {
  pool: pg.Pool;
  queries: string[];
  values: unknown[][];
};

function probePool(row: Record<string, unknown> | null): ProbePool {
  const queries: string[] = [];
  const values: unknown[][] = [];
  return {
    pool: {
      async query(text: string, params: unknown[]) {
        queries.push(text);
        values.push(params);
        if (row === null) throw new Error("probe unavailable");
        return { rows: [row] };
      },
    } as unknown as pg.Pool,
    queries,
    values,
  };
}

test("delivery snapshot reports the counters the ops route serves", async () => {
  const occurredAt = new Date(Date.now() - 90_000);
  const recordedAt = new Date(Date.now() - 80_000);
  const fixture = probePool({
    pending: 7,
    pending_deliverable: 5,
    pending_containment: 2,
    oldest_recorded_at: recordedAt,
    oldest_occurred_at: occurredAt,
  });
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    async () => new Response(),
  );

  const snapshot = await delivery.snapshot();
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.lastSuccessAt, null);
  assert.equal(snapshot.nextAttemptAt, null);
  assert.equal(snapshot.expiredTotal, 0);
  assert.equal(snapshot.expiredContainmentTotal, 0);
  assert.equal(snapshot.maxAge, "1 hour");
  assert.equal(snapshot.containmentBatchSize, 1);
  assert.equal(snapshot.queue?.pending, 7);
  assert.equal(snapshot.queue?.pendingDeliverable, 5);
  assert.equal(snapshot.queue?.pendingContainment, 2);
  assert.equal(snapshot.queue?.pendingCapped, false);
  assert.equal(snapshot.queue?.oldestPendingOccurredAt, occurredAt.toISOString());
  assert.ok((snapshot.queue?.oldestPendingAgeMs ?? 0) >= 90_000);

  // The probe must stay bounded and must drive the partial pending index.
  const sql = fixture.queries[0] ?? "";
  assert.match(sql, /WHERE dashboard_delivered_at IS NULL/);
  assert.match(sql, /ORDER BY recorded_at, id\s+LIMIT \$1/);
  assert.deepEqual(fixture.values[0]?.[0], 1_000);

  // Memoized: a second read inside the TTL must not re-query.
  await delivery.snapshot();
  assert.equal(fixture.queries.length, 1);
});

test("a failed queue probe degrades to counters instead of failing the route", async () => {
  const fixture = probePool(null);
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    async () => new Response(),
  );

  const snapshot = await delivery.snapshot();
  assert.equal(snapshot.queue, null);
  assert.equal(snapshot.lastDeliveredCount, 0);
});

test("the delivery operations route is authenticated and leaks no identifiers", () => {
  const server = read("services/antifraud-monitor/src/server.ts");
  const auth = read("services/antifraud-monitor/src/auth.ts");

  assert.match(server, /app\.get\("\/v1\/operations\/delivery"/);
  assert.match(server, /data: await ingestDelivery\.snapshot\(\)/);

  // The probe carve-out in the onRequest hook is what makes a route
  // unauthenticated. The delivery route must never appear in it.
  const carveOut = server.slice(
    server.indexOf("const requestPathname = request.url.split"),
    server.indexOf("const origin = request.headers.origin"),
  );
  assert.ok(carveOut.length > 0);
  assert.doesNotMatch(carveOut, /operations\/delivery/);
  assert.doesNotMatch(auth, /operations\/delivery/);

  // Counts and timestamps only: the snapshot type must not carry subject
  // identifiers or anything derived from configuration secrets.
  const delivery = read("services/antifraud-monitor/src/ingest-delivery.ts");
  const snapshotType = delivery.slice(
    delivery.indexOf("export type IngestDeliveryQueue"),
    delivery.indexOf("type QueueProbeRow"),
  );
  assert.ok(snapshotType.length > 0);
  for (const forbidden of [
    "userId",
    "username",
    "email",
    "ip",
    "fingerprint",
    "secret",
    "url",
    "token",
  ]) {
    assert.doesNotMatch(
      snapshotType,
      new RegExp(`\\b${forbidden}`, "i"),
      forbidden,
    );
  }
});
