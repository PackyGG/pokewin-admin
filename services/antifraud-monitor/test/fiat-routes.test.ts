import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Databases } from "../src/db.js";
import { registerFiatRoutes } from "../src/fiat-routes.js";
import type { FiatRiskService } from "../src/fiat-risk.js";

const intentId = "00000000-0000-4000-8000-000000000001";
const kycPredicate =
  "COALESCE((account_evidence->>'kycRequired')::boolean,false)=false";

type QueryCall = {
  sql: string;
  values: unknown[];
};

async function buildApp() {
  const calls: QueryCall[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes("SELECT DISTINCT user_id")) return { rows: [] };
    if (sql.includes("FROM \"user\"") && sql.includes("role::text")) {
      return { rows: [] };
    }

    const excludesKyc = sql.includes(kycPredicate);
    const searchesNeedle = values.includes("%needle%");
    const total = searchesNeedle
      ? excludesKyc
        ? 4
        : 6
      : excludesKyc
        ? 17
        : 23;

    if (sql.includes("COUNT(*)::int AS count") && !sql.includes("verdict=")) {
      return { rows: [{ count: total }] };
    }
    if (sql.includes("COUNT(*)::int AS total")) {
      return {
        rows: [
          {
            total,
            good: total,
            review: 0,
            bad: 0,
            unreviewed: total,
            in_review: 0,
            escalated: 0,
            hold_recommended: 0,
            provider_high_risk: 0,
            three_ds_failed: 0,
            disputed: 0,
            amount_usd: total * 10,
          },
        ],
      };
    }
    if (sql.includes("ORDER BY occurred_at DESC")) {
      return {
        rows: [
          {
            deposit_intent_id: intentId,
            account_evidence: { kycRequired: false },
          },
        ],
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const db = {
    antifraud: { query },
    source: { query },
  } as unknown as Databases;
  const refreshes: Array<Record<string, unknown>> = [];
  const service = {
    refresh: async (input: Record<string, unknown>) => {
      refreshes.push(input);
      return { ids: [intentId] };
    },
  } as unknown as FiatRiskService;
  const app = Fastify();
  await registerFiatRoutes(app, db, service);
  return { app, calls, refreshes };
}

test("fiat list API preserves its existing include-KYC default", async () => {
  const { app, calls } = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/fiat-deposits?limit=10",
    headers: { "x-antifraud-excluded-users": "[]" },
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().pagination, {
    page: 1,
    limit: 10,
    total: 23,
    pages: 3,
  });
  const assessmentQueries = calls.filter((call) =>
    call.sql.includes("fiat_deposit_assessments"),
  );
  assert.ok(assessmentQueries.length >= 3);
  assert.ok(assessmentQueries.every((call) => !call.sql.includes(kycPredicate)));
});

test("explicit KYC exclusion applies before rows, counts, and summaries", async () => {
  const { app, calls } = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/fiat-deposits?limit=3&page=2&excludeKycRequired=true",
    headers: { "x-antifraud-excluded-users": "[]" },
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().pagination, {
    page: 2,
    limit: 3,
    total: 17,
    pages: 6,
  });
  const listQuery = calls.find((call) =>
    call.sql.includes("ORDER BY occurred_at DESC"),
  );
  const countQuery = calls.find(
    (call) =>
      call.sql.includes("COUNT(*)::int AS count") &&
      !call.sql.includes("verdict="),
  );
  const summaryQuery = calls.find((call) =>
    call.sql.includes("COUNT(*)::int AS total"),
  );
  assert.ok(listQuery?.sql.includes(kycPredicate));
  assert.ok(countQuery?.sql.includes(kycPredicate));
  assert.ok(summaryQuery?.sql.includes(kycPredicate));
});

test("a concrete search includes KYC-required matching payments", async () => {
  const { app, calls } = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/fiat-deposits?search=needle&excludeKycRequired=true",
    headers: { "x-antifraud-excluded-users": "[]" },
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().pagination.total, 6);
  const listQuery = calls.find((call) =>
    call.sql.includes("ORDER BY occurred_at DESC"),
  );
  const countQuery = calls.find(
    (call) =>
      call.sql.includes("COUNT(*)::int AS count") &&
      !call.sql.includes("verdict="),
  );
  const summaryQuery = calls.find((call) =>
    call.sql.includes("COUNT(*)::int AS total"),
  );
  assert.ok(!listQuery?.sql.includes(kycPredicate));
  assert.ok(!countQuery?.sql.includes(kycPredicate));
  assert.ok(!summaryQuery?.sql.includes(kycPredicate));
  assert.ok(listQuery?.values.includes("%needle%"));
  assert.ok(countQuery?.values.includes("%needle%"));
  assert.match(
    listQuery?.sql ?? "",
    /provider_evidence->>'checkoutEmail'/,
  );
  assert.match(
    countQuery?.sql ?? "",
    /provider_evidence->>'checkoutEmail'/,
  );
});

test("an explicit false value retains the include-KYC API behavior", async () => {
  const { app, calls } = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/fiat-deposits?excludeKycRequired=false",
    headers: { "x-antifraud-excluded-users": "[]" },
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().pagination.total, 23);
  const assessmentQueries = calls.filter((call) =>
    call.sql.includes("fiat_deposit_assessments"),
  );
  assert.ok(assessmentQueries.every((call) => !call.sql.includes(kycPredicate)));
});

test("the list is never capped to the just-refreshed ids", async () => {
  const { app, calls } = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/fiat-deposits?limit=10",
    headers: { "x-antifraud-excluded-users": "[]" },
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  // `view` carries a default, so the old narrowing guard was never false and
  // the branch never ran. Reviving it would cap every unfiltered list at the
  // newest 100 rows and hand back an empty page 2, so it is gone for good.
  assert.ok(
    calls.every((call) => !call.sql.includes("deposit_intent_id=ANY(")),
  );
});

test("only page one pays for a re-score of the newest intents", async () => {
  const first = await buildApp();
  await first.app.inject({
    method: "GET",
    url: "/v1/fiat-deposits?limit=10",
    headers: { "x-antifraud-excluded-users": "[]" },
  });
  await first.app.close();
  assert.equal(first.refreshes.length, 1);

  const deeper = await buildApp();
  await deeper.app.inject({
    method: "GET",
    url: "/v1/fiat-deposits?limit=10&page=7",
    headers: { "x-antifraud-excluded-users": "[]" },
  });
  await deeper.app.close();
  // refresh() always pulls ORDER BY created_at DESC LIMIT 100 and ignores the
  // page, so paging deeper only re-scored the same newest 100 rows.
  assert.equal(deeper.refreshes.length, 0);
});

test("search wildcards a human can paste are escaped before LIKE", async () => {
  const { app, calls } = await buildApp();
  await app.inject({
    method: "GET",
    url: "/v1/fiat-deposits?limit=10&search=%5F",
    headers: { "x-antifraud-excluded-users": "[]" },
  });
  await app.close();

  const listQuery = calls.find((call) =>
    call.sql.includes("ORDER BY occurred_at DESC"),
  );
  // An unescaped `_` matches any character, turning a narrow staff lookup into
  // a full scan that also returns the wrong rows.
  assert.ok(listQuery?.values.includes(String.raw`%\_%`));
});
