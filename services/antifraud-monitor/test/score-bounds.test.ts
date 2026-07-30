import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { clampRiskScore } from "../src/scoring.js";

test("risk scores are bounded to the public 0-100 scale", () => {
  assert.equal(clampRiskScore(-20), 0);
  assert.equal(clampRiskScore(55.4), 55);
  assert.equal(clampRiskScore(120), 100);
  assert.equal(clampRiskScore(155), 100);
});

test("legacy aggregates are repaired before database score constraints apply", async () => {
  const migration = await readFile(
    new URL("../migrations/043_enforce_score_bounds.sql", import.meta.url),
    "utf8",
  );

  for (const table of [
    "signup_assessments",
    "cases",
    "monitor_sessions",
    "risk_events",
  ]) {
    assert.match(migration, new RegExp(`UPDATE ${table}`));
  }
  assert.match(migration, /CHECK \(score BETWEEN 0 AND 100\)/);
  assert.match(migration, /CHECK \(score_after BETWEEN 0 AND 100\)/);
});

test("monitor snapshot and stream boundaries clamp legacy scores", async () => {
  const [server, consoleSource, stream] = await Promise.all([
    readFile(new URL("../src/server.ts", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../../../src/app/(antifraud)/antifraud/monitor/monitor-console.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../src/app/(antifraud)/antifraud/_components/monitor-stream.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(server, /LEAST\(100, GREATEST\(0, ms\.current_score\)\)/);
  assert.match(server, /score: clampRiskScore\(Number\(row\.score\)\)/);
  assert.match(consoleSource, /function riskScore\(/);
  assert.match(stream, /Math\.max\(0, Math\.min\(100, Math\.round\(parsed\)\)\)/);
});
