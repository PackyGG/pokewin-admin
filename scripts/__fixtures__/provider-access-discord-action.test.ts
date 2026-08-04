import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("all provider failures use the consolidated third-party API action", () => {
  const migration = read(
    "drizzle/admin/migrations/20260803_provider_access_discord_event.sql",
  );
  const alerts = read(
    "services/antifraud-monitor/src/provider-access-alerts.ts",
  );
  const enrichment = read(
    "services/antifraud-monitor/src/enrichment.ts",
  );
  const maxmind = read("services/antifraud-monitor/src/maxmind.ts");
  const server = read("services/antifraud-monitor/src/server.ts");

  assert.match(migration, /antifraud\.error\.provider_access/);
  assert.match(alerts, /antifraud\.error\.third_party_api/);
  assert.match(migration, /missing or invalid/);
  assert.match(migration, /exhausted or running low/);
  assert.match(alerts, /provider-access:\$\{issue\.provider\}:\$\{issue\.kind\}/);
  assert.match(alerts, /queries_remaining/);
  assert.match(alerts, /funds_remaining/);
  assert.match(alerts, /request_failed/);
  assert.match(alerts, /kind: "timeout"/);
  assert.match(enrichment, /reportAccessFailure\("fingerprint"/);
  assert.match(enrichment, /reportAccessFailure\("maxmind"/);
  assert.match(maxmind, /maxmindAccessIssue\(raw\)/);
  assert.match(server, /missingProviderCredentials\(process\.env\)/);
  assert.doesNotMatch(alerts, /API_KEY.*description|LICENSE_KEY.*description/);
});
