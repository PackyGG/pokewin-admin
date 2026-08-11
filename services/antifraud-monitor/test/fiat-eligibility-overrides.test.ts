import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Databases } from "../src/db.js";
import { registerFiatEligibilityOverrideRoutes } from
  "../src/fiat-eligibility-overrides.js";

type OverrideRow = {
  environment: "dev" | "prod";
  user_id: string;
  enabled: boolean;
  reason: string;
  updated_by: string;
  updated_by_username: string | null;
  updated_at: Date;
};

function fixture() {
  let row: OverrideRow | undefined;
  const audit = new Map<string, {
    environment: "dev" | "prod";
    user_id: string;
    enabled: boolean;
    reason: string;
    actor_id: string;
  }>();
  const calls: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes("FROM fiat_eligibility_overrides")) {
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("FROM fiat_eligibility_override_audit")) {
      const found = audit.get(String(values[0]));
      return { rows: found ? [found] : [] };
    }
    if (sql.includes("INSERT INTO fiat_eligibility_overrides")) {
      row = {
        environment: values[0] as "dev" | "prod",
        user_id: String(values[1]),
        enabled: Boolean(values[2]),
        reason: String(values[3]),
        updated_by: String(values[4]),
        updated_by_username: values[5] == null ? null : String(values[5]),
        updated_at: new Date("2026-08-12T12:00:00.000Z"),
      };
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO fiat_eligibility_override_audit")) {
      audit.set(String(values[6]), {
        environment: values[0] as "dev" | "prod",
        user_id: String(values[1]),
        enabled: Boolean(values[2]),
        reason: String(values[3]),
        actor_id: String(values[4]),
      });
      return { rows: [] };
    }
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release() {} };
  const antifraud = { query, connect: async () => client };
  return {
    calls,
    db: { antifraud } as unknown as Databases,
  };
}

test("missing override is returned as disabled for production", async () => {
  const current = fixture();
  const app = Fastify();
  await registerFiatEligibilityOverrideRoutes(app, current.db);

  const response = await app.inject({
    method: "GET",
    url: "/v1/fiat-eligibility/overrides/user-1",
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, {
    environment: "prod",
    userId: "user-1",
    enabled: false,
    reason: null,
    updatedBy: null,
    updatedByUsername: null,
    updatedAt: null,
  });
});

test("override updates are durable, audited, and idempotent", async () => {
  const current = fixture();
  const app = Fastify();
  await registerFiatEligibilityOverrideRoutes(app, current.db);
  const payload = {
    environment: "prod",
    enabled: true,
    reason: "Known-safe customer approved by support.",
    actorId: "admin-1",
    actorUsername: "operator",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
  };

  const first = await app.inject({
    method: "PUT",
    url: "/v1/fiat-eligibility/overrides/user-1",
    payload,
  });
  const replay = await app.inject({
    method: "PUT",
    url: "/v1/fiat-eligibility/overrides/user-1",
    payload,
  });
  await app.close();

  assert.equal(first.statusCode, 200);
  assert.equal(first.json().data.enabled, true);
  assert.equal(first.json().data.idempotent, false);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().data.idempotent, true);
  assert.equal(
    current.calls.filter((sql) =>
      sql.includes("INSERT INTO fiat_eligibility_override_audit"),
    ).length,
    1,
  );
});
