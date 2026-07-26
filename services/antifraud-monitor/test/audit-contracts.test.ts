import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import type pg from "pg";

import { serviceRequestAuthorized } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { sameDecisionIdentity } from "../src/decision-idempotency.js";
import { pollerStalledFor, type PollerHealthSnapshot } from "../src/poller-health.js";
import { parseEnvelope, STREAM_ID_PATTERN } from "../src/live.js";
import { processOrderedBatch } from "../src/ordered-ingestion.js";
import { createPromiseCache } from "../src/promise-cache.js";
import { caseDecisionSchema } from "../src/request-schemas.js";
import { sameRuleUpdateIdentity } from "../src/rule-idempotency.js";
import { sanitizedRuntimeConfig } from "../src/runtime-config.js";
import {
  fetchActivity,
  fetchNewSignups,
  RAIN_WINNER_LOOKBACK_DAYS,
  rewardSourceRef,
  signupContext,
  storedIpv6,
  topRainWinners,
} from "../src/source.js";
import type { ActiveSession, Signup } from "../src/types.js";

type CapturedQuery = { sql: string; values: unknown[] | undefined };

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
  TZ: "UTC",
  PORT: 4100,
  SOURCE_DATABASE_URL: "postgresql://source-user:source-secret@source/db",
  SOURCE_DATABASE_SSL: "disable",
  ANTIFRAUD_DATABASE_URL: "postgresql://fraud-user:fraud-secret@fraud/db",
  ANTIFRAUD_DATABASE_SSL: "disable",
  REDIS_URL: "redis://default:redis-secret@redis",
  FINGERPRINT_SECRET_API_KEY: "fingerprint-secret",
  FINGERPRINT_REGION: "eu",
  PROXYCHECK_API_KEY: "proxycheck-secret",
  API_TOKEN: "read-token-that-is-at-least-32-characters",
  API_ADMIN_TOKEN: "admin-token-that-is-at-least-32-characters",
  PUBLIC_BASE_URL: "https://monitor.example.com",
  ANTIFRAUD_DASHBOARD_URL: "https://fraud.packydash.com/monitor",
  ANTIFRAUD_DISCORD_WEBHOOK_URL:
    "https://discord.com/api/webhooks/secret-id/secret-token",
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

  assert.equal(status.discord.webhookConfigured, true);
  assert.equal(status.discord.dashboardUrlConfigured, true);
  assert.equal(status.discord.supportRecipientIds.length, 3);
  assert.equal(status.discord.urgentRecipientIds.length, 4);
  assert.deepEqual(status.providers, {
    fingerprintConfigured: true,
    proxycheckConfigured: true,
  });
  assert.deepEqual(status.live, {
    redisConfigured: true,
    readTokenConfigured: true,
    adminTokenConfigured: true,
    exactOriginsConfigured: true,
  });
  for (const secret of [
    runtimeConfig.SOURCE_DATABASE_URL,
    runtimeConfig.ANTIFRAUD_DATABASE_URL,
    runtimeConfig.REDIS_URL,
    runtimeConfig.FINGERPRINT_SECRET_API_KEY,
    runtimeConfig.PROXYCHECK_API_KEY,
    runtimeConfig.API_TOKEN,
    runtimeConfig.API_ADMIN_TOKEN,
    runtimeConfig.ANTIFRAUD_DISCORD_WEBHOOK_URL ?? "",
    runtimeConfig.ANTIFRAUD_DASHBOARD_URL,
  ]) {
    assert.equal(serialized.includes(secret), false);
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
  assert.deepEqual(activity.queries[0]?.values, [
    session.user_id,
    session.activity_cursor_at,
    session.activity_cursor_source,
    session.activity_cursor_ref,
    2_000,
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
    source.queries.map((query) => query.values?.[5]),
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
  assert.match(
    server,
    /case_id,user_id,action_type,status,actor_id,actor_username,reason/,
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
