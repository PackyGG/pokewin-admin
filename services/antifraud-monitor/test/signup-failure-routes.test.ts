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
        error: failure.error_text,
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
  const audit = queries.find((query) =>
    query.sql.includes("INSERT INTO service_audit_events")
  );
  assert.ok(audit);
  assert.equal(audit.params?.[3], "signup_failure.retry");
  await app.close();
});

test("resolved failures leave the retry queue and new failures reopen them", async () => {
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
    /last_failed_at = now\(\),[\s\S]*resolved_at = NULL,[\s\S]*resolved_by = NULL,[\s\S]*resolution_note = NULL/,
  );
});
