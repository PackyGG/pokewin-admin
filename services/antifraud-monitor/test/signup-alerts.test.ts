import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HIGH_RISK_SIGNUP_SCORE,
  highRiskSignupMarker,
} from "../src/signup-alerts.js";

test("50 is the inclusive signup review notification floor", () => {
  assert.equal(HIGH_RISK_SIGNUP_SCORE, 50);

  const marker = highRiskSignupMarker({
    userId: "user-1",
    caseId: "case-1",
    score: 60,
    signals: [
      {
        key: "shared_device",
        title: "Shared device",
        detail: "Three accounts share a device.",
        points: 60,
      },
    ],
  });

  assert.equal(marker.eventType, "high_risk_signup");
  assert.equal(marker.source, "signup_alert");
  assert.equal(marker.sourceRef, "user-1:high_risk_signup");
  assert.equal(marker.payload.monitorCaseId, "case-1");
});

test("score-50 signup delivery uses durable independent sinks", async () => {
  const source = await readFile(
    new URL("../src/monitor.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../migrations/014_signup_review_delivery.sql", import.meta.url),
    "utf8",
  );

  assert.match(source, /score >= HIGH_RISK_SIGNUP_SCORE/);
  assert.match(source, /INSERT INTO signup_alert_outbox/);
  assert.match(source, /INSERT INTO risk_events/);
  assert.match(source, /highRiskSignupMarker/);
  assert.match(source, /title: "High-risk signup detected"/);
  assert.match(source, /severity: severity\(alert\.score\)/);
  assert.match(source, /signals,/);
  assert.match(source, /deliverPendingSignupAlerts/);
  assert.match(migration, /CHECK \(score >= 60\)/);
  assert.match(migration, /FROM signup_assessments sa/);
  assert.match(migration, /'high_risk_signup'/);
  assert.match(migration, /WHERE discord_delivered_at IS NULL/);
});
