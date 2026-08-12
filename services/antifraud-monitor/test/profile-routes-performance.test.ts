import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Databases } from "../src/db.js";
import { registerProfileRoutes } from "../src/profile-routes.js";

test("profile detail loads all antifraud evidence with one connection", async () => {
  const antifraudSql: string[] = [];
  const db = {
    antifraud: {
      query: async (sql: string) => {
        antifraudSql.push(sql);
        return {
          rows: [{
            user_id: "user-1",
            username: "one",
            email: "one@example.test",
            avatar_url: null,
            signup_ip: "127.0.0.1",
            country: "Test",
            country_code: "TT",
            state: null,
            city: null,
            source_created_at: new Date("2026-01-01T00:00:00.000Z"),
            assessment_version: "v1",
            raw_score: 10,
            score: 10,
            severity: "low",
            outcome: "clear",
            completeness: "complete",
            confidence: 1,
            provider_status: {},
            policy_matches: [],
            recommended_actions: [],
            explanation: {},
            assessed_at: new Date("2026-01-02T00:00:00.000Z"),
            assessments: [{ id: "assessment-1" }],
            providers: [{ id: "provider-1" }],
            relationships: [{ id: "relationship-1" }],
            blocklist_matches: [{ id: "match-1" }],
          }],
        };
      },
    },
    source: {
      query: async () => ({
        rows: [{
          id: "user-1",
          is_banned: false,
          banned_reason: null,
          banned_at: null,
          is_locked: false,
          locked_reason: null,
        }],
      }),
    },
  } as unknown as Databases;
  const app = Fastify();
  await registerProfileRoutes(app, db);

  const response = await app.inject({
    method: "GET",
    url: "/v1/profiles/user-1",
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.equal(antifraudSql.length, 1);
  assert.match(antifraudSql[0] ?? "", /FROM profile_assessment_history/);
  assert.match(antifraudSql[0] ?? "", /FROM profile_provider_evidence/);
  assert.match(antifraudSql[0] ?? "", /FROM account_relationship_evidence/);
  assert.match(antifraudSql[0] ?? "", /FROM identifier_blocklist_matches/);
  assert.deepEqual(response.json().data.assessments, [{ id: "assessment-1" }]);
});

test("profile list folds the exact count into the page query", async () => {
  const antifraudSql: string[] = [];
  const db = {
    antifraud: {
      query: async (sql: string) => {
        antifraudSql.push(sql);
        return {
          rows: [{
            user_id: "user-1",
            username: "one",
            email: null,
            avatar_url: null,
            country_code: null,
            source_created_at: new Date("2026-01-01T00:00:00.000Z"),
            score: 1,
            raw_score: 1,
            severity: "low",
            outcome: "clear",
            completeness: "complete",
            confidence: 1,
            policy_matches: [],
            assessed_at: new Date("2026-01-02T00:00:00.000Z"),
            updated_at: new Date("2026-01-02T00:00:00.000Z"),
            total_count: 41,
          }],
        };
      },
    },
    source: { query: async () => ({ rows: [] }) },
  } as unknown as Databases;
  const app = Fastify();
  await registerProfileRoutes(app, db);

  const response = await app.inject({ method: "GET", url: "/v1/profiles" });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.equal(antifraudSql.length, 1);
  assert.match(antifraudSql[0] ?? "", /COUNT\(\*\) OVER \(\)/);
  assert.equal(response.json().pagination.total, 41);
});
