import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Config } from "../src/config.js";
import {
  deliveryBackoffMs,
  IngestDelivery,
  ingestEvent,
  type RiskEventRow,
  signIngest,
} from "../src/ingest-delivery.js";

const config = {
  ANTIFRAUD_INGEST_URL:
    "https://fraud.packydash.com/api/antifraud/ingest",
  ANTIFRAUD_INGEST_SECRET: "s".repeat(64),
} as Config;

const row: RiskEventRow = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  case_id: "223e4567-e89b-42d3-a456-426614174000",
  session_id: "323e4567-e89b-42d3-a456-426614174000",
  user_id: "user-1",
  username: "player",
  event_type: "shared_device",
  source: "signup",
  source_ref: "user-1:shared_device",
  score_delta: 40,
  score_after: 75,
  title: "Shared device",
  detail: "Three accounts share this device.",
  payload: { count: 3 },
  occurred_at: new Date("2026-01-01T00:00:00.000Z"),
  recorded_at: new Date("2026-01-01T00:00:01.000Z"),
};

const quietLogger = {
  warn() {},
} as unknown as FastifyBaseLogger;

function deliveryPool(
  rows: RiskEventRow[],
): { pool: pg.Pool; queries: string[] } {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes("JOIN fiat_email_domain_matches")) {
        return {
          rows: rows.filter((event) =>
            event.event_type === "fiat_blacklisted_email_domain"
            || event.event_type === "abstract_email_catchall"
          ),
        };
      }
      if (sql.includes("FROM risk_events")) return { rows };
      return { rows: [] };
    },
    release() {},
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    } as unknown as pg.Pool,
    queries,
  };
}

test("signed ingest uses the dashboard timestamp.rawBody HMAC contract", () => {
  const timestamp = "1720000000000";
  const body = JSON.stringify({ events: [{ type: "signal" }] });
  const expected =
    "sha256=" +
    createHmac("sha256", config.ANTIFRAUD_INGEST_SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex");
  assert.equal(
    signIngest(config.ANTIFRAUD_INGEST_SECRET, timestamp, body),
    expected,
  );
});

test("risk rows map to bounded dashboard signal fields", () => {
  assert.deepEqual(ingestEvent(row), {
    type: "signal",
    id: row.id,
    kind: "shared_device",
    severity: "critical",
    riskScore: 75,
    userId: "user-1",
    username: "player",
    summary: "Shared device — Three accounts share this device.",
    payload: {
      count: 3,
      caseId: row.case_id,
      sessionId: row.session_id,
      source: "signup",
      sourceRef: "user-1:shared_device",
      scoreDelta: 40,
      scoreAfter: 75,
    },
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(
    ingestEvent({ ...row, payload: { blob: "x".repeat(4_000) } }).payload,
    {
      deliveryPayloadTruncated: true,
      caseId: row.case_id,
      sessionId: row.session_id,
      source: "signup",
      sourceRef: "user-1:shared_device",
      scoreDelta: 40,
      scoreAfter: 75,
    },
  );

  const containment = ingestEvent({
    ...row,
    event_type: "fiat_deposit_identity_containment",
    payload: {
      containmentRequired: true,
      containmentAction: "withdrawals",
      reviewOnly: false,
      environment: "prod",
      intentId: "intent-1",
      reasonCodes: ["checkout_refunded_amount_cluster"],
      refundedAmountClusterActiveUntil: "2026-08-12T00:00:00.000Z",
      evidence: "x".repeat(4_000),
    },
  });
  assert.deepEqual(containment.payload, {
    deliveryPayloadTruncated: true,
    containmentRequired: true,
    containmentAction: "withdrawals",
    reviewOnly: false,
    environment: "prod",
    intentId: "intent-1",
    reasonCodes: ["checkout_refunded_amount_cluster"],
    refundedAmountClusterActiveUntil: "2026-08-12T00:00:00.000Z",
    caseId: row.case_id,
    sessionId: row.session_id,
    source: "signup",
    sourceRef: "user-1:shared_device",
    scoreDelta: 40,
    scoreAfter: 75,
  });
});

test("delivery advances only after every event is confirmed", async () => {
  const fixture = deliveryPool([row]);
  let request: { url: string; init?: RequestInit } | null = null;
  const send = async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> => {
    request = { url: String(input), init };
    return new Response(
      JSON.stringify({ ok: true, accepted: 1, duplicates: 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    send,
  );

  assert.equal(await delivery.flushOnce(), 1);
  assert.ok(request);
  const sent = request as { url: string; init?: RequestInit };
  assert.equal(sent.url, config.ANTIFRAUD_INGEST_URL);
  const rawBody = String(sent.init?.body);
  const timestamp = String(
    (sent.init?.headers as Record<string, string>)["x-antifraud-timestamp"],
  );
  assert.equal(
    (sent.init?.headers as Record<string, string>)["x-antifraud-signature"],
    signIngest(config.ANTIFRAUD_INGEST_SECRET, timestamp, rawBody),
  );
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("UPDATE ingest_delivery_cursors")
    ),
    true,
  );
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("UPDATE risk_events") &&
      sql.includes("dashboard_delivered_at")
    ),
    true,
  );
  assert.equal(fixture.queries[0], "BEGIN");
  assert.equal(fixture.queries.at(-1), "COMMIT");
  assert.equal(
    fixture.queries.some((sql) => sql.includes("pg_advisory_unlock")),
    false,
  );
});

test("successful containment delivery confirms the lock without mirror lag", async () => {
  const containment: RiskEventRow = {
    ...row,
    event_type: "fiat_blacklisted_email_domain",
    source_ref:
      "blacklisted-signup:423e4567-e89b-42d3-a456-426614174000",
  };
  const fixture = deliveryPool([containment]);
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    async () =>
      new Response(
        JSON.stringify({ ok: true, accepted: 1, duplicates: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  assert.equal(await delivery.flushOnce(), 1);
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("WITH confirmed_matches AS") &&
      sql.includes("lock_delivered_at = COALESCE") &&
      sql.includes("event.id = ANY($1::uuid[])") &&
      sql.includes("SELECT count(*) FROM confirmed_matches")
    ),
    true,
  );
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("match.source_event_id = substring(") &&
      sql.includes("position(':' IN re.source_ref) + 1") &&
      !sql.includes("split_part(re.source_ref, ':', 2)")
    ),
    true,
  );
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("UPDATE risk_events") &&
      sql.includes("dashboard_delivered_at")
    ),
    true,
  );
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("UPDATE ingest_delivery_cursors")
    ),
    false,
  );
});

test("review-only email signals cannot acknowledge cluster containment", async () => {
  const review: RiskEventRow = {
    ...row,
    event_type: "fiat_blacklisted_email_domain",
    source_ref: "blacklisted-checkout:cluster-event-1",
    payload: {
      emailDomain: "gmail.com",
      emailRiskType: "gmail_dot_fragmentation",
      matchSource: "whop_checkout",
      reviewOnly: true,
    },
  };
  const fixture = deliveryPool([review]);
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    async () =>
      new Response(
        JSON.stringify({ ok: true, accepted: 1, duplicates: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  assert.equal(await delivery.flushOnce(), 1);
  assert.equal(
    fixture.queries.some((sql) => sql.includes("WITH confirmed_matches AS")),
    false,
  );
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("reviewOnly") && sql.includes("IS DISTINCT FROM 'true'")
    ),
    true,
  );
});

test("cluster containment retries a failed direct lock and confirms recovery", async () => {
  const containment: RiskEventRow = {
    ...row,
    event_type: "fiat_blacklisted_email_domain",
    source_ref: "blacklisted-checkout:cluster-event-1",
    payload: {
      emailDomain: "gmail.com",
      emailRiskType: "suspicious_deposit_cluster",
      matchSource: "whop_checkout",
    },
  };
  const fixture = deliveryPool([containment]);
  let attempt = 0;
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    async () => {
      attempt += 1;
      return attempt === 1
        ? new Response("unavailable", { status: 503 })
        : new Response(
            JSON.stringify({ ok: true, accepted: 1, duplicates: 0 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
    },
  );

  await assert.rejects(
    delivery.flushOnce(),
    /Dashboard ingest returned HTTP 503/,
  );
  assert.equal(
    fixture.queries.some((sql) => sql.includes("WITH confirmed_matches AS")),
    false,
  );

  assert.equal(await delivery.flushOnce(), 1);
  assert.equal(attempt, 2);
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("WITH confirmed_matches AS") &&
      sql.includes("lock_delivered_at = COALESCE")
    ),
    true,
  );
});

test("signed delivery batches stay bounded for containment writes", async () => {
  const fixture = deliveryPool([]);
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    async () => new Response(),
  );

  assert.equal(await delivery.flushOnce(), 0);
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("dashboard_delivered_at IS NULL") &&
      /LIMIT \$1/.test(sql)
    ),
    true,
  );
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/ingest-delivery.ts", import.meta.url), "utf8")
  );
  assert.match(source, /const BATCH_SIZE = 10/);
  assert.match(source, /const CONTAINMENT_BATCH_SIZE = 1/);
  assert.match(source, /Promise\.race\(\[/);
  assert.match(source, /if \(delivered > 0 && !this\.stopped\)/);
});

test("partial confirmation keeps the cursor for an idempotent retry", async () => {
  const fixture = deliveryPool([row]);
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    async () =>
      new Response(
        JSON.stringify({ ok: true, accepted: 0, duplicates: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  await assert.rejects(delivery.flushOnce(), /confirmed 0\/1 events/);
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("UPDATE ingest_delivery_cursors")
    ),
    false,
  );
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("UPDATE risk_events") &&
      sql.includes("dashboard_delivered_at")
    ),
    false,
  );
  assert.equal(fixture.queries.at(-1), "ROLLBACK");
});

test("delivery leader lease is transaction-scoped", async () => {
  const fixture = deliveryPool([]);
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    async () => new Response(),
  );

  assert.equal(await delivery.flushOnce(), 0);
  assert.equal(fixture.queries[0], "BEGIN");
  assert.equal(
    fixture.queries.some((sql) => sql.includes("pg_try_advisory_xact_lock")),
    true,
  );
  assert.equal(fixture.queries.at(-1), "COMMIT");
});

test("Abstract catch-all containment is delivered ahead of ordinary events", async () => {
  const containment: RiskEventRow = {
    ...row,
    event_type: "abstract_email_catchall",
    source: "abstract_email",
    source_ref: "user-1:abstract_email_catchall",
    score_after: 100,
    payload: {
      containmentRequired: true,
      emailDomain: "example.com",
      provider: "abstract_email",
    },
  };
  const fixture = deliveryPool([containment]);
  const delivery = new IngestDelivery(
    config,
    fixture.pool,
    quietLogger,
    async () =>
      new Response(
        JSON.stringify({ ok: true, accepted: 1, duplicates: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  assert.equal(await delivery.flushOnce(), 1);
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("event_type = 'abstract_email_catchall'")
      && sql.includes("dashboard_delivered_at IS NULL")
    ),
    true,
  );
  assert.equal(
    fixture.queries.some((sql) =>
      sql.includes("UPDATE risk_events")
      && sql.includes("dashboard_delivered_at")
    ),
    true,
  );
});

test("migration replays containment events skipped by the old cursor race", async () => {
  const migration = await import("node:fs/promises").then(({ readFile }) =>
    readFile(
      new URL(
        "../migrations/028_dashboard_delivery_receipts.sql",
        import.meta.url,
      ),
      "utf8",
    )
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS dashboard_delivered_at/);
  assert.match(
    migration,
    /event_type <> 'risky_free_battle_containment'/,
  );
  assert.match(
    migration,
    /WHERE dashboard_delivered_at IS NULL/,
  );
});

test("delivery retries back off to one minute", () => {
  assert.equal(deliveryBackoffMs(1), 5_000);
  assert.equal(deliveryBackoffMs(2), 10_000);
  assert.equal(deliveryBackoffMs(10), 60_000);
});
