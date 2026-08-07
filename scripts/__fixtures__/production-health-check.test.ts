import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  formatHealthReport,
  runProductionHealthChecks,
} from "../production-health-check.mjs";

const baseInput = {
  baseUrl: "https://packydash.example",
  railwayHealthUrl: "https://backend.example",
  healthToken: "test-cron-secret",
  timeoutMs: 1_000,
};

test("production monitor validates all three health contracts and authenticates DB", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, authorization: headers.get("authorization") });
    if (url.endsWith("/login")) {
      return new Response("login", { status: 200 });
    }
    if (url.endsWith("/api/health/antifraud-webapp")) {
      return Response.json({ status: "healthy" });
    }
    if (url.endsWith("/api/health/postgres")) {
      return Response.json({
        ok: true,
        reachable: true,
        replicationHealthy: true,
      });
    }
    return Response.json({ status: "ok" });
  };

  const report = await runProductionHealthChecks({ ...baseInput, fetchImpl });
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 4);
  assert.equal(
    seen.find(({ url }) => url.endsWith("/api/health/postgres"))?.authorization,
    "Bearer test-cron-secret",
  );
  assert.equal(
    seen.find(({ url }) => url.endsWith("/api/health/antifraud-webapp"))
      ?.authorization,
    null,
  );
});

test("HTTP 500 and unhealthy database payloads produce actionable failures", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/login")) {
      return new Response("platform failure", { status: 500 });
    }
    if (url.endsWith("/api/health/antifraud-webapp")) {
      return new Response("platform failure", { status: 500 });
    }
    if (url.endsWith("/api/health/postgres")) {
      return Response.json(
        { ok: false, reachable: false, replicationHealthy: false },
        { status: 503 },
      );
    }
    return Response.json({ status: "ok" });
  };

  const report = await runProductionHealthChecks({ ...baseInput, fetchImpl });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.checks.map(({ ok, status }) => ({ ok, status })),
    [
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ],
  );
  const summary = formatHealthReport(report);
  assert.match(summary, /FAIL Vercel application: HTTP 500/);
  assert.match(summary, /FAIL Vercel runtime: HTTP 500/);
  assert.match(summary, /FAIL PostgreSQL mirror: HTTP 503/);
  assert.doesNotMatch(summary, /test-cron-secret/);
});

test("monitor rejects insecure targets and missing auth without making requests", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json({ status: "ok" });
  };

  await assert.rejects(
    runProductionHealthChecks({
      ...baseInput,
      railwayHealthUrl: "http://backend.example",
      fetchImpl,
    }),
    /RAILWAY_HEALTH_URL must use https/,
  );
  await assert.rejects(
    runProductionHealthChecks({ ...baseInput, healthToken: "", fetchImpl }),
    /CRON_SECRET is not configured/,
  );
  assert.equal(calls, 0);
});

test("scheduled workflow deduplicates incidents and keeps Discord optional", () => {
  const workflow = readFileSync(
    join(process.cwd(), ".github/workflows/production-health.yml"),
    "utf8",
  );

  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /CRON_SECRET:.*secrets\.CRON_SECRET/);
  assert.match(workflow, /RAILWAY_HEALTH_URL:.*vars\.RAILWAY_HEALTH_URL/);
  assert.match(
    workflow,
    /https:\/\/grand-cooperation-production-ffe1\.up\.railway\.app\/health/,
  );
  assert.match(workflow, /issue\.title === title/);
  assert.match(workflow, /if \(failed && !openIncident\)/);
  assert.match(workflow, /else if \(!failed && openIncident\)/);
  assert.match(workflow, /allowed_mentions: \{ parse: \[\] \}/);
  assert.match(workflow, /if: steps\.health\.outcome != 'success'/);
  assert.match(
    workflow,
    /ANTIFRAUD_DISCORD_WEBHOOK_URL:.*secrets\.ANTIFRAUD_DISCORD_WEBHOOK_URL/,
  );
});
