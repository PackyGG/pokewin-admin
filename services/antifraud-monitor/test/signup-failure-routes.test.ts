import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Fastify from "fastify";

import { serviceRequestAuthorized } from "../src/auth.js";
import type { Config } from "../src/config.js";
import type { Databases } from "../src/db.js";
import { registerSignupFailureRoutes } from "../src/signup-failure-routes.js";

const config = {
  API_TOKEN: "read-token-that-is-at-least-32-characters",
  API_ADMIN_TOKEN: "admin-token-that-is-at-least-32-characters",
} as Pick<Config, "API_TOKEN" | "API_ADMIN_TOKEN">;

const failure = {
  user_id: "user-1",
  error_text: "Provider enrichment unavailable: timeout",
  failure_count: 6,
  first_failed_at: new Date("2026-07-29T20:00:00Z"),
  last_failed_at: new Date("2026-07-29T21:00:00Z"),
  resolved_at: null,
  resolved_by: null,
  resolution_note: null,
};

test("signup failure operations require the admin service token", () => {
  const routes = [
    ["GET", "/v1/operations/signup-failures"],
    ["POST", "/v1/operations/signup-failures/user-1/retry"],
    ["POST", "/v1/operations/signup-failures/user-1/resolve"],
  ] as const;
  for (const [method, path] of routes) {
    assert.equal(
      serviceRequestAuthorized(method, path, config.API_TOKEN, config),
      false,
    );
    assert.equal(
      serviceRequestAuthorized(method, path, config.API_ADMIN_TOKEN, config),
      true,
    );
  }
});

test("signup failure list exposes bounded operator evidence", async () => {
  const queries: string[] = [];
  const app = Fastify();
  await registerSignupFailureRoutes(app, {
    antifraud: {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [failure], rowCount: 1 };
      },
    },
  } as unknown as Databases);

  const response = await app.inject({
    method: "GET",
    url: "/v1/operations/signup-failures?status=pending&limit=20",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    data: [
      {
        userId: "user-1",
        errorCode: "provider_enrichment_unavailable",
        errorSummary: "A signup enrichment provider was unavailable.",
        failureCount: 6,
        firstFailedAt: "2026-07-29T20:00:00.000Z",
        lastFailedAt: "2026-07-29T21:00:00.000Z",
        status: "pending",
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
      },
    ],
  });
  assert.match(queries[0] ?? "", /WHERE resolved_at IS NULL/);
  assert.doesNotMatch(response.body, /timeout/);
  await app.close();
});

test("signup failure list maps internal errors to allowlisted operator summaries", async () => {
  const app = Fastify();
  await registerSignupFailureRoutes(app, {
    antifraud: {
      query: async () => ({
        rows: [
          {
            ...failure,
            user_id: "constraint-user",
            error_text:
              'new row violates check constraint "signup_alert_outbox_score_check"',
          },
          {
            ...failure,
            user_id: "payload-user",
            error_text: "Stored signup payload is invalid",
          },
          {
            ...failure,
            user_id: "unknown-user",
            error_text: "database error containing private@example.com",
          },
        ],
        rowCount: 3,
      }),
    },
  } as unknown as Databases);

  const response = await app.inject({
    method: "GET",
    url: "/v1/operations/signup-failures",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(
    body.data.map((item: { errorCode: string }) => item.errorCode),
    [
      "signup_alert_score_contract",
      "invalid_stored_payload",
      "signup_assessment_failed",
    ],
  );
  assert.doesNotMatch(response.body, /private@example\.com|check constraint/);
  await app.close();
});

test("retry requeues one failure and records the exact staff action", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const retried = {
    ...failure,
    failure_count: 0,
    last_failed_at: new Date(0),
  };
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("FROM service_audit_events")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FOR UPDATE")) {
        return { rows: [failure], rowCount: 1 };
      }
      if (sql.includes("UPDATE signup_ingestion_failures")) {
        return { rows: [retried], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  const app = Fastify();
  await registerSignupFailureRoutes(app, {
    antifraud: { connect: async () => client },
  } as unknown as Databases);

  const response = await app.inject({
    method: "POST",
    url: "/v1/operations/signup-failures/user-1/retry",
    payload: {
      idempotencyKey: "3d4e2357-a1ca-4f5e-b7db-56f3989292ba",
      actorId: "admin-1",
      actorUsername: "owner",
      reason: "Retry after provider recovery",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.failureCount, 0);
  assert.match(
    queries.find((query) => query.sql.includes("UPDATE signup_ingestion_failures"))
      ?.sql ?? "",
    /failure_count=0[\s\S]*last_failed_at=to_timestamp\(0\)/,
  );
  assert.ok(
    queries.some((query) => query.sql.includes("pg_advisory_xact_lock")),
    "the idempotency key must be locked before the audit lookup",
  );
  const audit = queries.find((query) =>
    query.sql.includes("INSERT INTO service_audit_events")
  );
  assert.ok(audit);
  assert.equal(audit.params?.[3], "signup_failure.retry");
  await app.close();
});

test("signup recovery migration repairs the contract and requeues affected rows", async () => {
  const migration = await readFile(
    new URL("../migrations/068_signup_recovery_hardening.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    migration,
    /UPDATE signup_alert_outbox[\s\S]*SET score = LEAST\(100, GREATEST\(0, score\)\)[\s\S]*WHERE score NOT BETWEEN 0 AND 100/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT signup_alert_outbox_score_bounds_check[\s\S]*CHECK \(score BETWEEN 0 AND 100\) NOT VALID/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT signup_alert_outbox_score_bounds_check[\s\S]*DROP CONSTRAINT IF EXISTS signup_alert_outbox_score_check/,
  );
  assert.match(
    migration,
    /UPDATE signup_ingestion_failures[\s\S]*failure_count = 0[\s\S]*last_failed_at = to_timestamp\(0\)/,
  );
  assert.match(
    migration,
    /WHERE resolved_at IS NULL[\s\S]*error_text LIKE '%signup_alert_outbox_score_check%'/,
  );
  assert.doesNotMatch(migration, /CHECK \(score >= (?:21|50|60)\)/);
});

test("resolved failures win races with automatic recovery", async () => {
  const migration = await readFile(
    new URL("../migrations/033_signup_failure_operations.sql", import.meta.url),
    "utf8",
  );
  const monitor = await readFile(
    new URL("../src/monitor.ts", import.meta.url),
    "utf8",
  );
  assert.match(migration, /WHERE resolved_at IS NULL/);
  assert.match(
    monitor,
    /FROM signup_ingestion_failures[\s\S]*WHERE resolved_at IS NULL/,
  );
  assert.match(
    monitor,
    /DELETE FROM signup_ingestion_failures[\s\S]*WHERE user_id = \$1[\s\S]*AND resolved_at IS NULL/,
  );
  assert.match(
    monitor,
    /ON CONFLICT \(user_id\) DO UPDATE SET[\s\S]*resolution_note = NULL[\s\S]*WHERE signup_ingestion_failures\.resolved_at IS NULL/,
  );
});

test("post-commit signup rule failures cannot dead-letter committed ingestion", async () => {
  const monitor = await readFile(
    new URL("../src/monitor.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    monitor,
    /try \{[\s\S]*await this\.evaluateRules\(\{[\s\S]*Signup committed but its rules could not be evaluated/,
  );
});
