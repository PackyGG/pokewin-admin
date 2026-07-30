import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverUrl = new URL("../src/server.ts", import.meta.url);
const migrationUrl = new URL(
  "../migrations/042_overview_indexes.sql",
  import.meta.url,
);

test("overview endpoint exposes bounded real review, blacklist, and session data", async () => {
  const [server, migration] = await Promise.all([
    readFile(serverUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);

  assert.match(server, /app\.get\("\/v1\/overview"/);
  assert.match(server, /JOIN signup_assessments/);
  assert.match(server, /FROM fiat_deposit_assessments/);
  assert.match(server, /verdict = 'bad' AS is_fraud/);
  assert.match(server, /status = ANY\(\$1::text\[\]\)/);
  // Refunded money stays out of the legitimate and fraud legs, but it is now
  // reported on its own leg instead of disappearing from the KPI entirely.
  assert.match(
    server,
    /status IN \('refunded', 'partially_refunded'\) AS is_refunded/,
  );
  assert.match(server, /WHERE NOT is_fraud AND NOT is_refunded/);
  assert.match(server, /WHERE is_fraud AND NOT is_refunded/);
  assert.match(server, /FILTER \(WHERE is_refunded\) \* 100/);
  assert.match(server, /refundedLifetimeCents/);
  assert.match(server, /fraudulentRefundedLifetimeCents/);
  assert.match(server, /user_id <> ALL\(\$2::text\[\]\)/);
  assert.match(server, /interval '29 days'/);
  assert.match(server, /last24HoursCents/);
  assert.match(server, /legitimateLifetimeCents/);
  assert.match(server, /fraudulentFiat/);
  assert.match(server, /FROM fiat_email_domain_blacklist/);
  assert.match(server, /hard_policy = 'blocklist\.ip'/);
  assert.match(server, /ms\.started_at >= now\(\) - interval '30 days'/);
  assert.match(server, /ORDER BY ms\.started_at DESC, ms\.id DESC/);
  assert.match(server, /LIMIT 40/);
  assert.match(
    migration,
    /ON monitor_sessions\(started_at DESC, id DESC\)/,
  );
});
