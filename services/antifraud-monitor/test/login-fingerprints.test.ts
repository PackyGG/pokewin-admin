import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fetchNewLoginFingerprints } from "../src/source.js";

test("login fingerprint polling is verified-event-only and tuple bounded", async () => {
  let sql = "";
  let values: unknown[] = [];
  const pool = {
    query: async (text: string, parameters: unknown[]) => {
      sql = text;
      values = parameters;
      return { rows: [] };
    },
  };
  const occurredAt = new Date("2026-08-04T19:00:00.000Z");
  await fetchNewLoginFingerprints(
    pool as never,
    { occurredAt, sourceId: "fingerprint-id" },
    25,
  );

  assert.match(sql, /fp\.event_type = 'login'/);
  assert.match(sql, /\(fp\.created_at, fp\.id::text\) > \(\$1::timestamptz, \$2::text\)/);
  assert.match(sql, /COUNT\(DISTINCT other\.user_id\)/);
  assert.deepEqual(values, [occurredAt, "fingerprint-id", 25]);
});

test("login evidence is durable, review-scoped, and refreshes the device graph", async () => {
  const monitor = await readFile(
    new URL("../src/monitor.ts", import.meta.url),
    "utf8",
  );
  assert.match(monitor, /'login_fingerprints', now\(\) - interval '24 hours'/);
  assert.match(monitor, /'login_fingerprint_captured','fingerprint_login_archive'/);
  assert.match(monitor, /actionableDevice \? 35 : 0/);
  assert.match(monitor, /INSERT INTO cases\(/);
  assert.match(monitor, /await this\.onSignupAssessed\?\.\(login\.user_id\)/);
  assert.doesNotMatch(monitor, /persistLoginFingerprint[\s\S]{0,5000}(ban|lock_withdrawals)/);
});
