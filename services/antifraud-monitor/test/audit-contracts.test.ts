import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { WebSocket } from "ws";

import { serviceRequestAuthorized } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { sameDecisionIdentity } from "../src/decision-idempotency.js";
import { pollerStalledFor, type PollerHealthSnapshot } from "../src/poller-health.js";
import {
  LiveBus,
  MAX_CONNECTIONS_PER_ACTOR,
  parseEnvelope,
  STREAM_ID_PATTERN,
} from "../src/live.js";
import { processOrderedBatch } from "../src/ordered-ingestion.js";
import { drainOutbox, outboxRetrySeconds } from "../src/outbox.js";
import {
  notificationRouteStatuses,
  notificationRoutesForFiatProblem,
  signedIngestTarget,
} from "../src/notification-routes.js";
import { createPromiseCache } from "../src/promise-cache.js";
import { caseDecisionSchema } from "../src/request-schemas.js";
import { sameRuleUpdateIdentity } from "../src/rule-idempotency.js";
import { sanitizedRuntimeConfig } from "../src/runtime-config.js";
import { SCORE_WEIGHT_KEYS } from "../src/score-catalog.js";
import { parseFailedSignup } from "../src/signup-failure.js";
import {
  fetchActivity,
  fetchNewSignups,
  RAIN_WINNER_LOOKBACK_DAYS,
  rewardSourceRef,
  signupContext,
  storedIpv6,
  topRainWinners,
} from "../src/source.js";
import {
  clientErrorStatus,
  ticketRateLimitKey,
} from "../src/transport-limits.js";
import type { ActiveSession, Signup } from "../src/types.js";

type CapturedQuery = { sql: string; values: unknown[] | undefined };

class FakeRedis extends EventEmitter {
  status = "ready";
  evalCalls: unknown[][] = [];
  setResults: Array<"OK" | null> = ["OK"];
  setCalls = 0;
  quitCalls = 0;

  async subscribe(): Promise<number> {
    return 1;
  }

  async eval(...args: unknown[]): Promise<string> {
    this.evalCalls.push(args);
    return "1720000000000-1";
  }

  async set(): Promise<"OK" | null> {
    this.setCalls += 1;
    return this.setResults.shift() ?? null;
  }

  async call(): Promise<null> {
    return null;
  }

  async quit(): Promise<"OK"> {
    this.quitCalls += 1;
    return "OK";
  }
}

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readyState = this.OPEN;
  bufferedAmount = 0;
  terminated = 0;
  sent: string[] = [];

  send(payload: string, callback?: (error?: Error) => void): void {
    this.sent.push(payload);
    callback?.();
  }

  ping(): void {}

  close(): void {
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

function liveBusFixture(): {
  bus: LiveBus;
  publisher: FakeRedis;
  subscriber: FakeRedis;
} {
  const publisher = new FakeRedis();
  const subscriber = new FakeRedis();
  const bus = new LiveBus("redis://fixture", quietLogger, {
    publisher: publisher as unknown as Redis,
    subscriber: subscriber as unknown as Redis,
  });
  return { bus, publisher, subscriber };
}

function capturePool(
  rows: unknown[] = [],
): { pool: pg.Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return { rows };
    },
  } as unknown as pg.Pool;
  return { pool, queries };
}

const session: ActiveSession = {
  id: "session-1",
  case_id: "case-1",
  user_id: "user-1",
  initial_score: 10,
  current_score: 10,
  started_at: new Date("2026-01-01T00:00:00.000Z"),
  ends_at: new Date("2026-01-01T00:03:00.000Z"),
  activity_cursor_at: new Date("2026-01-01T00:00:01.000Z"),
  activity_cursor_source: "ledger",
  activity_cursor_ref: "same-time-1",
};

const signup: Signup = {
  id: "user-1",
  username: "user",
  email: null,
  image: null,
  signup_ip: "unknown, 203.0.113.1",
  country: null,
  country_code: null,
  continent_code: null,
  state: null,
  city: null,
  affiliate_code: null,
  referred_by: null,
  is_suspected_alt: false,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  fingerprint_request_id: null,
  visitor_id: null,
  fingerprint_confidence: null,
  fingerprint_ip: null,
  user_agent: null,
};

const runtimeConfig: Config = {
  NODE_ENV: "test",
  FIAT_ELIGIBILITY_CONTAINMENT_ENABLED: true,
  FIAT_DEPOSIT_IDENTITY_CONTAINMENT_ENABLED: true,
  TZ: "UTC",
  PORT: 4100,
  SOURCE_DATABASE_URL: "postgresql://source-user:source-secret@source/db",
  SOURCE_DATABASE_SSL: "disable",
  FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_SSL: "disable",
  ANTIFRAUD_DATABASE_URL: "postgresql://fraud-user:fraud-secret@fraud/db",
  ANTIFRAUD_DATABASE_SSL: "disable",
  REDIS_URL: "redis://default:redis-secret@redis",
  FINGERPRINT_SECRET_API_KEY: "fingerprint-secret",
  FINGERPRINT_REGION: "eu",
  PROXYCHECK_API_KEY: "proxycheck-secret",
  ABSTRACT_IP_INTELLIGENCE_API_KEY: "abstract-ip-secret",
  ABSTRACT_EMAIL_REPUTATION_API_KEY: "abstract-email-secret",
  MAXMIND_ACCOUNT_ID: "123456",
  MAXMIND_LICENSE_KEY: "maxmind-license-key-for-testing",
  MAXMIND_ALERT_WEBHOOK_SECRET: "maxmind-alert-secret-at-least-32-characters",
  API_TOKEN: "read-token-that-is-at-least-32-characters",
  API_ADMIN_TOKEN: "admin-token-that-is-at-least-32-characters",
  FIAT_ACCESS_API_BASE_URL: "https://packy.gg/v1",
  FIAT_ELIGIBILITY_DEV_ALLOWED_IPS: "",
  FIAT_ELIGIBILITY_PROD_ALLOWED_IPS: "",
  FIAT_ELIGIBILITY_GLOBALLY_ENABLED: false,
  FIAT_ELIGIBILITY_RATE_LIMIT_PER_MINUTE: 120,
  PUBLIC_BASE_URL: "https://monitor.example.com",
  ANTIFRAUD_DASHBOARD_URL: "https://fraud.packydash.com/monitor",
  ANTIFRAUD_INGEST_URL:
    "https://fraud.packydash.com/api/antifraud/ingest",
  ANTIFRAUD_INGEST_SECRET: "ingest-secret-that-is-at-least-32-characters",
  ANTIFRAUD_WEBAPP_HEALTH_URL:
    "https://fraud.packydash.com/api/health/antifraud-webapp",
  ADMIN_GUILD_ID: "1483064422778798112",
  FIAT_ALERT_DASHBOARD_URL:
    "https://fraud.packydash.com/fiat-deposits",
  ALLOWED_ORIGINS: "https://fraud.packydash.com",
  API_RATE_LIMIT_PER_MINUTE: 300,
  API_WRITE_RATE_LIMIT_PER_MINUTE: 30,
  WS_TICKET_RATE_LIMIT_PER_MINUTE: 30,
  POLL_INTERVAL_MS: 1_000,
  POLL_SIGNUP_BATCH_SIZE: 100,
  POLL_MAX_SIGNUP_BATCHES: 5,
  POLL_ACTIVITY_BATCH_SIZE: 2_000,
  POLL_ACTIVITY_OVERLAP_MS: 2_000,
  POLL_STALE_AFTER_MS: 15_000,
  POLLER_LIVENESS_TIMEOUT_MS: 120_000,
  MONITOR_DURATION_SECONDS: 180,
  MONITOR_START_SCORE: 25,
};

test("every config consumer is declared by the runtime schema", async () => {
  const srcUrl = new URL("../src/", import.meta.url);
  const configSource = await readFile(new URL("config.ts", srcUrl), "utf8");
  const schemaBody = configSource.match(
    /const schema = z\.object\(\{([\s\S]*?)\n\}\);/,
  )?.[1];
  assert.ok(schemaBody, "config schema body must remain statically discoverable");
  const declared = new Set(
    [...schemaBody.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map(
      (match) => match[1],
    ),
  );

  const consumed = new Set<string>();
  for (const file of await readdir(srcUrl)) {
    if (!file.endsWith(".ts") || file === "config.ts") continue;
    const source = await readFile(new URL(file, srcUrl), "utf8");
    for (const match of source.matchAll(/\bconfig\.([A-Z][A-Z0-9_]+)\b/g)) {
      if (match[1]) consumed.add(match[1]);
    }
    for (const match of source.matchAll(
      /\bprocess\.env\.([A-Z][A-Z0-9_]+)\b/g,
    )) {
      if (match[1]) consumed.add(match[1]);
    }
  }

  assert.deepEqual(
    [...consumed].filter((key) => !declared.has(key)),
    [],
  );
});

test("authoritative runtime status returns presence and compiled ids only", () => {
  const status = sanitizedRuntimeConfig(runtimeConfig, 1);
  const serialized = JSON.stringify(status);

  assert.equal(status.discord.botQueueConfigured, true);
  assert.equal(status.externalWebappMonitor.alertRouteConfigured, true);
  assert.equal(status.discord.dashboardUrlConfigured, true);
  // Recipient ids are no longer reported: they were a second, drift-prone copy
  // of ANTIFRAUD_TEAM_IDS. Tag membership is admin-app configuration now.
  assert.ok(!("supportRecipientIds" in status.discord));
  assert.ok(!("urgentRecipientIds" in status.discord));
  assert.deepEqual(status.providers, {
    fingerprintConfigured: true,
    proxycheckConfigured: true,
    abstractIpConfigured: true,
    abstractEmailConfigured: true,
    maxmindFactorsConfigured: true,
    maxmindAlertsConfigured: true,
  });
  assert.equal(
    status.providerContracts.fingerprint.model,
    "Fingerprint Pro Plus",
  );
  assert.equal(
    status.providerContracts.proxycheck.version,
    "24-June-2026",
  );
  assert.deepEqual(status.live, {
    redisConfigured: true,
    readTokenConfigured: true,
    adminTokenConfigured: true,
    exactOriginsConfigured: true,
  });
  assert.deepEqual(status.ingest, {
    endpointConfigured: true,
    secretConfigured: true,
  });
  for (const secret of [
    runtimeConfig.SOURCE_DATABASE_URL,
    runtimeConfig.ANTIFRAUD_DATABASE_URL,
    runtimeConfig.REDIS_URL,
    runtimeConfig.FINGERPRINT_SECRET_API_KEY,
    runtimeConfig.PROXYCHECK_API_KEY,
    runtimeConfig.API_TOKEN,
    runtimeConfig.API_ADMIN_TOKEN,
    runtimeConfig.FIAT_ALERT_DASHBOARD_URL,
    runtimeConfig.ANTIFRAUD_DASHBOARD_URL,
    runtimeConfig.ANTIFRAUD_INGEST_URL,
    runtimeConfig.ANTIFRAUD_INGEST_SECRET,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("notification registry owns every producer route and missing state", async () => {
  const routes = notificationRouteStatuses({
    ANTIFRAUD_INGEST_URL: runtimeConfig.ANTIFRAUD_INGEST_URL,
    ANTIFRAUD_INGEST_SECRET: runtimeConfig.ANTIFRAUD_INGEST_SECRET,
    ADMIN_GUILD_ID: runtimeConfig.ADMIN_GUILD_ID,
  });
  assert.deepEqual(
    routes.map((route) => [route.label, route.configured]),
    [
      ["Antifraud risk", true],
      ["Fiat operations", true],
      ["High-risk fiat supplemental", true],
      ["Email containment", true],
      ["Withdrawal holds", true],
      ["Signed dashboard ingest", true],
    ],
  );
  for (const route of routes) {
    assert.deepEqual(Object.keys(route).sort(), [
      "configured",
      "eventFamilies",
      "label",
      "purpose",
    ]);
    assert.ok(route.label.length > 0);
    assert.ok(route.purpose.length > 0);
    assert.ok(route.eventFamilies.length > 0);
  }

  assert.deepEqual(notificationRoutesForFiatProblem("high_risk"), [
    "antifraud_risk",
    "high_risk_supplemental",
  ]);
  assert.deepEqual(
    notificationRoutesForFiatProblem("blacklisted_email_domain"),
    ["email_blacklist"],
  );
  assert.deepEqual(notificationRoutesForFiatProblem("failed"), [
    "fiat_operations",
  ]);
  assert.deepEqual(signedIngestTarget(runtimeConfig), {
    url: runtimeConfig.ANTIFRAUD_INGEST_URL,
    secret: runtimeConfig.ANTIFRAUD_INGEST_SECRET,
  });

  const srcUrl = new URL("../src/", import.meta.url);
  const producerContracts = [
    ["discord.ts", "sendBotDiscordEvent"],
    ["fiat-alerts.ts", "sendBotDiscordEvent"],
    ["ingest-delivery.ts", "signedIngestTarget"],
    ["server.ts", "notificationRouteStatuses"],
  ] as const;
  for (const [file, helper] of producerContracts) {
    const source = await readFile(new URL(file, srcUrl), "utf8");
    assert.match(source, new RegExp(`\\b${helper}\\b`));
  }
});

test("Discord alert routing uses the signed bot queue only", async () => {
  const srcUrl = new URL("../src/", import.meta.url);
  for (const file of [
    "config.ts",
    "discord.ts",
    "fiat-alerts.ts",
    "monitor.ts",
    "notification-routes.ts",
    "server.ts",
  ]) {
    const source = await readFile(new URL(file, srcUrl), "utf8");
    assert.doesNotMatch(source, /DISCORD_WEBHOOK_URL/);
  }
});

test("operations config accepts read/admin tokens and rejects missing tokens", () => {
  const path = "/v1/operations/config";
  assert.equal(
    serviceRequestAuthorized("GET", path, runtimeConfig.API_TOKEN, runtimeConfig),
    true,
  );
  assert.equal(
    serviceRequestAuthorized(
      "GET",
      path,
      runtimeConfig.API_ADMIN_TOKEN,
      runtimeConfig,
    ),
    true,
  );
  assert.equal(serviceRequestAuthorized("GET", path, "", runtimeConfig), false);
  assert.equal(
    serviceRequestAuthorized(
      "PUT",
      "/v1/rules/rule-id",
      runtimeConfig.API_TOKEN,
      runtimeConfig,
    ),
    false,
  );
  assert.equal(
    serviceRequestAuthorized(
      "PUT",
      "/v1/scoring/fingerprint_vpn",
      runtimeConfig.API_TOKEN,
      runtimeConfig,
    ),
    false,
  );
  assert.equal(
    serviceRequestAuthorized(
      "PUT",
      "/v1/scoring/fingerprint_vpn",
      runtimeConfig.API_ADMIN_TOKEN,
      runtimeConfig,
    ),
    true,
  );
  assert.equal(
    serviceRequestAuthorized(
      "POST",
      "/v1/fiat-email-domains",
      runtimeConfig.API_TOKEN,
      runtimeConfig,
    ),
    false,
  );
  assert.equal(
    serviceRequestAuthorized(
      "POST",
      "/v1/fiat-email-domains",
      runtimeConfig.API_ADMIN_TOKEN,
      runtimeConfig,
    ),
    true,
  );
  assert.equal(
    serviceRequestAuthorized(
      "PUT",
      "/v1/fiat-email-domains/00000000-0000-4000-8000-000000000000",
      runtimeConfig.API_TOKEN,
      runtimeConfig,
    ),
    false,
  );
  const fiatReviewPath =
    "/v1/fiat-deposits/00000000-0000-4000-8000-000000000000/review";
  assert.equal(
    serviceRequestAuthorized(
      "POST",
      fiatReviewPath,
      runtimeConfig.API_TOKEN,
      runtimeConfig,
    ),
    false,
  );
  assert.equal(
    serviceRequestAuthorized(
      "POST",
      fiatReviewPath,
      runtimeConfig.API_ADMIN_TOKEN,
      runtimeConfig,
    ),
    true,
  );
});

test("notification route status accepts read/admin tokens and rejects missing tokens", () => {
  const path = "/v1/operations/notifications";
  assert.equal(
    serviceRequestAuthorized("GET", path, runtimeConfig.API_TOKEN, runtimeConfig),
    true,
  );
  assert.equal(
    serviceRequestAuthorized(
      "GET",
      path,
      runtimeConfig.API_ADMIN_TOKEN,
      runtimeConfig,
    ),
    true,
  );
  assert.equal(serviceRequestAuthorized("GET", path, "", runtimeConfig), false);
});

test("editable score migration seeds every runtime weight", async () => {
  const migration = [
    await readFile(
      new URL(
        "../migrations/006_editable_score_weights.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/007_signup_cluster_weights.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/014_signup_live_behavior_tuning.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/029_risky_location_scoring.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/030_risky_location_score_tuning.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/031_fingerprint_pro_plus_intelligence.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/035_abstract_signup_intelligence.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/041_fresh_account_behavior_policy.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ].join("\n");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS score_weights/);
  for (const key of SCORE_WEIGHT_KEYS) {
    assert.match(migration, new RegExp(`'${key}'`));
  }
});

test("promise cache coalesces cold loads, expires, and evicts rejection", async () => {
  let now = 1_000;
  let calls = 0;
  const cached = createPromiseCache(
    async (key: number) => {
      calls += 1;
      if (key === 9) throw new Error("transient");
      return `${key}:${calls}`;
    },
    100,
    () => now,
  );

  const first = cached(3);
  assert.equal(cached(3), first);
  assert.equal(await first, "3:1");
  assert.equal(calls, 1);

  now += 101;
  assert.equal(await cached(3), "3:2");
  await assert.rejects(cached(9), /transient/);
  await assert.rejects(cached(9), /transient/);
  assert.equal(calls, 4);
});

test("shared outbox drain reaches the five-minute retry ceiling", async () => {
  assert.equal(outboxRetrySeconds(1), 2);
  assert.equal(outboxRetrySeconds(8), 256);
  assert.equal(outboxRetrySeconds(9), 300);

  const recorded: Array<{ delivered: boolean; attempt: number; retry: number }> =
    [];
  await drainOutbox({
    fetchPending: async () => [{ attemptCount: 8 }],
    attemptCount: (row) => row.attemptCount,
    attempt: async () => ({ delivered: false }),
    record: async (_row, outcome) => {
      recorded.push({
        delivered: outcome.delivered,
        attempt: outcome.attempt,
        retry: outcome.retrySeconds,
      });
    },
  });
  assert.deepEqual(recorded, [{ delivered: false, attempt: 9, retry: 300 }]);
});

test("poison signup is dead-lettered and later siblings do not reemit", async () => {
  const items = ["a", "poison", "c"];
  const prepared: string[] = [];
  const emitted: string[] = [];
  const deadLetters: string[] = [];
  let cursor = "";

  const first = await processOrderedBatch(
    items,
    async (item) => {
      prepared.push(item);
      return item.toUpperCase();
    },
    async (item, value) => {
      if (item === "poison") throw new Error("invalid row");
      emitted.push(value);
      cursor = item;
    },
    async (item) => {
      deadLetters.push(item);
      cursor = item;
    },
  );
  assert.deepEqual(first, { committed: 2, deadLettered: 1 });
  assert.deepEqual(prepared, items);
  assert.deepEqual(deadLetters, ["poison"]);
  assert.deepEqual(emitted, ["A", "C"]);
  assert.equal(cursor, "c");

  const replay = await processOrderedBatch(
    items.slice(items.indexOf(cursor) + 1),
    async (item) => item,
    async (item) => {
      emitted.push(item);
    },
    async () => undefined,
  );
  assert.deepEqual(replay, { committed: 0, deadLettered: 0 });
  assert.deepEqual(emitted, ["A", "C"]);
});

test("stored signup failures restore dates and reject malformed payloads", () => {
  const restored = parseFailedSignup({
    ...signup,
    created_at: signup.created_at.toISOString(),
  });
  assert.ok(restored);
  assert.equal(restored.created_at instanceof Date, true);
  assert.equal(
    restored.created_at.toISOString(),
    signup.created_at.toISOString(),
  );
  assert.equal(parseFailedSignup({ ...signup, id: "" }), null);
  assert.equal(parseFailedSignup({ ...signup, created_at: "not-a-date" }), null);
});

test("live replay envelopes require valid ids and object payloads", () => {
  assert.equal(STREAM_ID_PATTERN.test("1720000000000-7"), true);
  assert.equal(STREAM_ID_PATTERN.test("latest"), false);
  assert.deepEqual(
    parseEnvelope(
      "1720000000000-7",
      JSON.stringify({
        type: "monitor.event",
        at: "2026-01-01T00:00:00.000Z",
        data: { caseId: "case-1" },
      }),
    ),
    {
      id: "1720000000000-7",
      schemaVersion: 1,
      correlationId: "legacy:1720000000000-7",
      type: "monitor.event",
      at: "2026-01-01T00:00:00.000Z",
      data: { caseId: "case-1" },
    },
  );
  assert.equal(parseEnvelope("1720000000000-8", "{"), null);
  assert.equal(
    parseEnvelope(
      "1720000000000-8",
      JSON.stringify({ type: "bad", at: "now", data: [] }),
    ),
    null,
  );
});

test("live publish persists and broadcasts through one atomic Redis command", async () => {
  const { bus, publisher } = liveBusFixture();

  await bus.publish("monitor.event", { caseId: "case-1" });

  assert.equal(publisher.evalCalls.length, 1);
  const [script, keyCount, stream, channel, maxLength, payload] =
    publisher.evalCalls[0] ?? [];
  assert.equal(typeof script, "string");
  assert.match(String(script), /XADD/);
  assert.match(String(script), /PUBLISH/);
  assert.deepEqual(
    [keyCount, stream, channel, maxLength],
    [2, "antifraud:live:stream", "antifraud:live", "2000"],
  );
  const message = JSON.parse(String(payload)) as Record<string, unknown>;
  assert.equal(message.type, "monitor.event");
  assert.equal(typeof message.at, "string");
  assert.deepEqual(message.data, { caseId: "case-1" });

  await bus.close();
});

test("websocket tickets retry a failed NX reservation", async () => {
  const { bus, publisher } = liveBusFixture();
  publisher.setResults = [null, "OK"];

  const ticket = await bus.createTicket({ actorId: "staff-1" });

  assert.match(ticket, /^[A-Za-z0-9_-]{40,100}$/);
  assert.equal(publisher.setCalls, 2);
  await bus.close();
});

test("websocket client errors evict with a coded close and release the actor slot", async () => {
  const { bus } = liveBusFixture();
  const clients = Array.from(
    { length: MAX_CONNECTIONS_PER_ACTOR + 1 },
    () => new FakeWebSocket(),
  );

  for (const client of clients.slice(0, MAX_CONNECTIONS_PER_ACTOR)) {
    assert.equal(
      bus.addClient(client as unknown as WebSocket, "staff-1"),
      true,
    );
  }
  assert.equal(
    bus.addClient(
      clients[MAX_CONNECTIONS_PER_ACTOR] as unknown as WebSocket,
      "staff-1",
    ),
    false,
  );

  clients[0]?.emit("error", new Error("peer reset"));
  // Errored clients are now evicted with a coded close (1011) instead of a
  // bare terminate, so peers do not see 1006 and hot-retry.
  assert.equal(clients[0]?.readyState, 3);
  assert.equal(
    bus.addClient(
      clients[MAX_CONNECTIONS_PER_ACTOR] as unknown as WebSocket,
      "staff-1",
    ),
    true,
  );

  await bus.close();
});

test("websocket ticket limits follow staff actors instead of shared server IPs", () => {
  const sharedIp = "10.0.0.1";
  assert.equal(
    ticketRateLimitKey({
      body: { actorId: "staff-1" },
      ip: sharedIp,
    } as never),
    "ws-ticket:actor:staff-1",
  );
  assert.equal(
    ticketRateLimitKey({
      body: { actorId: "staff-2" },
      ip: sharedIp,
    } as never),
    "ws-ticket:actor:staff-2",
  );
  assert.equal(
    ticketRateLimitKey({ body: {}, ip: sharedIp } as never),
    "ws-ticket:ip:10.0.0.1",
  );
});

test("safe client errors preserve their HTTP status", () => {
  assert.equal(clientErrorStatus({ statusCode: 429 }), 429);
  assert.equal(clientErrorStatus({ statusCode: 403 }), 403);
  assert.equal(clientErrorStatus({ statusCode: 500 }), null);
  assert.equal(clientErrorStatus(new Error("boom")), null);
});

test("signup and activity cursors preserve exact application-precision UTC tuples", async () => {
  const signups = capturePool();
  const cursorAt = new Date("2026-01-01T00:00:00.000Z");
  await fetchNewSignups(
    signups.pool,
    { occurredAt: cursorAt, sourceId: "equal-time-user" },
    25,
  );
  assert.match(
    signups.queries[0]?.sql ?? "",
    /date_trunc\('milliseconds', u\.created_at\).*u\.id\) >\s+\(date_trunc\('milliseconds', \$1::timestamptz AT TIME ZONE 'UTC'\), \$2::text\)/s,
  );
  assert.match(
    signups.queries[0]?.sql ?? "",
    /ORDER BY date_trunc\('milliseconds', u\.created_at\), u\.id/,
  );
  assert.deepEqual(signups.queries[0]?.values, [
    cursorAt,
    "equal-time-user",
    25,
  ]);
  const mirrorIndexes = await readFile(
    new URL(
      "../migrations/source-mirror-indexes.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    mirrorIndexes,
    /ON "user" \(date_trunc\('milliseconds', created_at\), id\)/,
  );
  assert.match(
    mirrorIndexes,
    /DROP INDEX CONCURRENTLY IF EXISTS antifraud_user_signup_cursor_idx/,
  );

  const activity = capturePool();
  await fetchActivity(activity.pool, [session], 40, 2_000);
  const sql = activity.queries[0]?.sql ?? "";
  assert.match(sql, /created_at AT TIME ZONE 'UTC' AS occurred_at/);
  assert.match(
    sql,
    />\s+\(\$2::timestamptz, \$3::text, \$4::text\)/,
  );
  assert.match(sql, /':granted'/);
  assert.match(sql, /':opened'/);
  assert.match(sql, /created_at <= \(\$6::timestamptz AT TIME ZONE 'UTC'\)/);
  assert.match(sql, /86b89005-d49f-46ad-9c38-f2a35b136eba/);
  assert.match(sql, /91577f77-8589-4e85-bea1-69bf37c46169/);
  assert.match(sql, /creator_sponsored_battle_received/);
  assert.match(sql, /b\.sponsorship_percentage > 0/);
  assert.match(sql, /WHEN lt\.type::text = 'deposit' THEN 'crypto_deposit'/);
  assert.doesNotMatch(sql, /deposit_unclassified/);
  assert.doesNotMatch(sql, /lt\.type::text <> 'rain_win'/);
  assert.deepEqual(activity.queries[0]?.values, [
    session.user_id,
    session.activity_cursor_at,
    session.activity_cursor_source,
    session.activity_cursor_ref,
    2_000,
    session.ends_at,
    40,
  ]);
});

test("activity fetch gives every live session its own bounded batch", async () => {
  const source = capturePool();
  await fetchActivity(
    source.pool,
    [
      session,
      { ...session, id: "session-2", user_id: "user-2" },
    ],
    40,
    2_000,
  );
  assert.equal(source.queries.length, 2);
  assert.deepEqual(
    source.queries.map((query) => query.values?.[6]),
    [20, 20],
  );
});

test("malformed stored IPv6 never enters an inet parameter query", async () => {
  assert.equal(storedIpv6("2001:db8::1"), "2001:db8::1");
  assert.equal(storedIpv6("unknown"), null);
  assert.equal(storedIpv6("2001:db8::1, 198.51.100.1"), null);
  assert.equal(storedIpv6("[2001:db8::1]:443"), null);

  const source = capturePool([{
    same_ip_10m: "1",
    same_ip_30m: "1",
  }]);
  const context = await signupContext(source.pool, signup);

  assert.equal(source.queries.length, 1);
  assert.equal(source.queries[0]?.values?.[0], signup.signup_ip);
  assert.doesNotMatch(source.queries[0]?.sql ?? "", /\$1::inet/);
  assert.equal(context.sameIpv6Subnet30m, 0);
});

test("signup context counts affiliate, affiliate-IP, and country bursts in bounded windows", async () => {
  const source = capturePool([{
    same_ip_10m: "4",
    same_ip_30m: "12",
    same_affiliate_30m: "11",
    same_affiliate_ip_30m: "7",
    same_country_15m: "26",
  }]);
  const clusteredSignup = {
    ...signup,
    signup_ip: "203.0.113.10",
    affiliate_code: "PACKY",
    country_code: "DE",
  };
  const context = await signupContext(source.pool, clusteredSignup);

  assert.equal(source.queries.length, 2);
  const clusterQuery = source.queries.find((query) =>
    query.sql.includes("same_affiliate_ip_30m")
  );
  assert.ok(clusterQuery);
  assert.deepEqual(clusterQuery.values, [
    clusteredSignup.signup_ip,
    clusteredSignup.created_at,
    clusteredSignup.affiliate_code,
    clusteredSignup.country_code,
  ]);
  assert.match(clusterQuery.sql, /interval '15 minutes'/);
  assert.match(clusterQuery.sql, /interval '30 minutes'/);
  assert.equal(context.sameAffiliate30m, 11);
  assert.equal(context.sameAffiliateIp30m, 7);
  assert.equal(context.sameCountry15m, 26);
});

test("top rain is time bounded and receives bound limit/lookback values", async () => {
  const source = capturePool();
  await topRainWinners(source.pool, 17);
  assert.equal(RAIN_WINNER_LOOKBACK_DAYS, 365);
  assert.deepEqual(source.queries[0]?.values, [17, 365]);
  assert.match(
    source.queries[0]?.sql ?? "",
    /created_at >= \(now\(\) AT TIME ZONE 'UTC'\) - \(\$2::int \* interval '1 day'\)/,
  );
  assert.match(source.queries[0]?.sql ?? "", /lt\.type = 'rain_win'/);
  assert.match(source.queries[0]?.sql ?? "", /lt\.status = 'completed'/);
  assert.doesNotMatch(
    source.queries[0]?.sql ?? "",
    /(?:type|status)::text =/,
  );
});

test("reward granted and opened states have distinct durable references", () => {
  const rewardId = "reward-row-1";
  assert.equal(rewardSourceRef(rewardId, null), "reward-row-1:granted");
  assert.equal(
    rewardSourceRef(rewardId, new Date("2026-01-01T00:00:00.000Z")),
    "reward-row-1:opened",
  );
  assert.notEqual(
    rewardSourceRef(rewardId, null),
    rewardSourceRef(rewardId, new Date()),
  );
});

test("cases index and staff actor persistence stay aligned with routes", async () => {
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../migrations/004_audit_hardening.sql", import.meta.url),
    "utf8",
  );

  for (const source of [server, migration]) {
    assert.match(source, /WHEN 'critical' THEN 4/);
    assert.match(source, /WHEN 'high' THEN 3/);
    assert.match(source, /WHEN 'medium' THEN 2/);
    assert.match(source, /updated_at DESC/);
  }
  assert.match(migration, /cases_severity_rank_updated_idx/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS actor_username text/);
  assert.match(server, /idempotency_key, actor_id, actor_username, action/);
  // /health is unauthenticated and trimmed to a status shape; the poller
  // counters (signupsRecovered etc.) are served by the authenticated
  // operations route instead of leaking on the public probe.
  assert.doesNotMatch(server, /signupsRecovered: poller\.signupsRecovered/);
  assert.match(server, /app\.get\("\/v1\/operations\/poller"/);
  assert.match(
    server,
    /case_id,user_id,action_type,status,actor_id,actor_username,reason/,
  );
});

test("account-case conflict target matches the partial unique index", async () => {
  const monitor = await readFile(
    new URL("../src/monitor.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL(
      "../migrations/008_account_networks_creator_fraud.sql",
      import.meta.url,
    ),
    "utf8",
  );

  for (const source of [monitor, migration]) {
    assert.match(source, /subject_type = 'account'/);
    assert.match(
      source,
      /status IN \('open',\s*'monitoring',\s*'in_review',\s*'escalated'\)/,
    );
  }
  assert.match(
    monitor,
    /ON CONFLICT \(user_id\) WHERE subject_type = 'account'/,
  );
});

test("monitor windows retain and reconstruct the exact signup interval", async () => {
  const monitor = await readFile(
    new URL("../src/monitor.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    monitor,
    /\$5::timestamptz \+ \(\$3::text \|\| ' seconds'\)::interval/,
  );
  assert.match(monitor, /WHERE ms\.status = 'active'/);
  assert.doesNotMatch(
    monitor,
    /WHERE ms\.status = 'active' AND ms\.ends_at > now\(\)/,
  );
});

test("decision schema accepts and preserves server-derived staff identity", () => {
  const parsed = caseDecisionSchema.parse({
    decision: "resolved_fraud",
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    reason: "Confirmed linked abuse.",
    actorId: "staff-user-id",
    actorUsername: "Support Agent",
  });
  assert.equal(parsed.actorId, "staff-user-id");
  assert.equal(parsed.actorUsername, "Support Agent");
});

test("monitor case decisions do not accept escalation", () => {
  const result = caseDecisionSchema.safeParse({
    decision: "escalated",
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    reason: "Legacy decision.",
    actorId: "staff-user-id",
    actorUsername: "staff",
  });
  assert.equal(result.success, false);
});

test("decision idempotency accepts exact replay and rejects identity changes", () => {
  const stored = {
    case_id: "case-1",
    action_type: "resolved_fraud",
    actor_id: "staff-1",
    actor_username: "Support Agent",
    reason: "Confirmed linked abuse.",
  };
  const requested = {
    caseId: "case-1",
    decision: "resolved_fraud",
    actorId: "staff-1",
    actorUsername: "Support Agent",
    reason: "Confirmed linked abuse.",
  };
  assert.equal(sameDecisionIdentity(stored, requested), true);
  assert.equal(
    sameDecisionIdentity(stored, { ...requested, caseId: "case-2" }),
    false,
  );
  assert.equal(
    sameDecisionIdentity(stored, { ...requested, decision: "resolved_safe" }),
    false,
  );
  assert.equal(
    sameDecisionIdentity(stored, { ...requested, actorId: "staff-2" }),
    false,
  );
  assert.equal(
    sameDecisionIdentity(stored, { ...requested, reason: "Different reason" }),
    false,
  );
});

test("rule idempotency is bound to the exact target, actor, and patch", () => {
  const requested = {
    targetId: "rule-1",
    actorId: "staff-1",
    actorUsername: "Support Agent",
    changes: { enabled: false, scoreDelta: 40 },
  };
  const stored = {
    action: "rule.update",
    target_id: "rule-1",
    actor_id: "staff-1",
    actor_username: "Support Agent",
    request_state: requested,
  };
  assert.equal(sameRuleUpdateIdentity(stored, requested), true);
  assert.equal(
    sameRuleUpdateIdentity(stored, { ...requested, targetId: "rule-2" }),
    false,
  );
  assert.equal(
    sameRuleUpdateIdentity(stored, {
      ...requested,
      changes: { enabled: true, scoreDelta: 40 },
    }),
    false,
  );
  assert.equal(
    sameRuleUpdateIdentity({ ...stored, request_state: null }, requested),
    false,
  );
});

test("leader liveness stalls only after its bounded timeout", () => {
  const base: PollerHealthSnapshot = {
    status: "healthy",
    running: false,
    leader: true,
    lastTickStartedAt: "2026-01-01T00:00:00.000Z",
    lastTickCompletedAt: "2026-01-01T00:00:01.000Z",
    lastSuccessfulTickAt: "2026-01-01T00:00:01.000Z",
    lastTickDurationMs: 1_000,
    consecutiveFailures: 0,
    skippedTicks: 0,
    signupsProcessed: 0,
    signupsRecovered: 0,
    signupFailuresPending: 0,
    activitiesProcessed: 0,
    signupBacklogPossible: false,
    signupCursorLagMs: 0,
    lastError: null,
  };

  assert.equal(
    pollerStalledFor(base, 120_000, Date.parse("2026-01-01T00:02:00.000Z")),
    null,
  );
  assert.equal(
    pollerStalledFor(base, 120_000, Date.parse("2026-01-01T00:02:02.000Z")),
    121_000,
  );
  assert.equal(
    pollerStalledFor(
      {
        ...base,
        lastSuccessfulTickAt: null,
        lastTickCompletedAt: null,
        lastTickStartedAt: "2026-01-01T00:00:00.000Z",
      },
      120_000,
      Date.parse("2026-01-01T00:02:01.000Z"),
    ),
    121_000,
  );
  assert.equal(pollerStalledFor({ ...base, leader: false }, 1, Infinity), null);
});

test("runtime workers recover cleanly from provider, pool, and process failures", async () => {
  const [monitor, network, ingest, db, server] = await Promise.all([
    readFile(new URL("../src/monitor.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/network-risk.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/ingest-delivery.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/db.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/server.ts", import.meta.url), "utf8"),
  ]);

  assert.match(monitor, /!this\.tickFailureRecorded/);
  assert.match(monitor, /result\.status === "failed"/);
  assert.match(monitor, /Provider enrichment unavailable/);
  assert.match(
    monitor,
    /error_text LIKE 'Provider enrichment unavailable:%'/,
  );

  assert.match(network, /void this\.runWorker\(\)/);
  assert.match(network, /Recovered after stale worker lease/);
  assert.match(network, /lease_owner=\$2/);
  assert.match(network, /lease_expires_at=now\(\)/);
  assert.match(network, /AND lease_owner=\$2/);
  assert.match(network, /await this\.workerPromise/);
  assert.match(network, /FROM unnest\(\$2::text\[\]\)/);
  assert.match(network, /await this\.recoverStaleJobs\(\);[\s\S]*?for \(let processed/);
  const recoveryMigration = await readFile(
    new URL(
      "../migrations/025_network_scan_job_recovery.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    recoveryMigration,
    /network_scan_jobs_running_lease_idx[\s\S]*WHERE status = 'running'/,
  );
  assert.match(recoveryMigration, /CREATE TABLE IF NOT EXISTS rule_alert_outbox/);
  assert.match(monitor, /INSERT INTO rule_alert_outbox/);
  assert.match(monitor, /deliverPendingRuleAlerts/);

  assert.match(ingest, /async start\(\): Promise<void> \{\s*void this\.tick\(\)/);

  assert.match(db, /source\.on\("error"/);
  assert.match(db, /antifraud\.on\("error"/);
  assert.match(server, /process\.once\("SIGTERM"/);
  assert.match(server, /process\.once\("SIGINT"/);
  assert.match(server, /app\.close\(\)/);
  assert.match(server, /process\.exit\(1\)/);
});
