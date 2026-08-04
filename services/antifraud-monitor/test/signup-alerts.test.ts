import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CRITICAL_RISK_SIGNUP_SCORE,
  HIGH_RISK_SIGNUP_SCORE,
  LOW_RISK_SIGNUP_SCORE,
  signupDiscordAlertKind,
  signupMonitorDurationSeconds,
  signupReviewMarker,
} from "../src/signup-alerts.js";

test("signup Discord bands have distinct low, high, and critical actions", () => {
  assert.equal(LOW_RISK_SIGNUP_SCORE, 21);
  assert.equal(HIGH_RISK_SIGNUP_SCORE, 50);
  assert.equal(CRITICAL_RISK_SIGNUP_SCORE, 70);
  assert.equal(signupDiscordAlertKind(20), null);
  assert.equal(signupDiscordAlertKind(21), "low_risk");
  assert.equal(signupDiscordAlertKind(49), "low_risk");
  assert.equal(signupDiscordAlertKind(50), "high_risk");
  assert.equal(signupDiscordAlertKind(69), "high_risk");
  assert.equal(signupDiscordAlertKind(70), "critical_risk");
  assert.equal(signupDiscordAlertKind(100), "critical_risk");
});

test("signup monitoring durations follow the four risk bands", () => {
  assert.equal(signupMonitorDurationSeconds(20), 0);
  assert.equal(signupMonitorDurationSeconds(21), 300);
  assert.equal(signupMonitorDurationSeconds(49), 300);
  assert.equal(signupMonitorDurationSeconds(50), 600);
  assert.equal(signupMonitorDurationSeconds(69), 600);
  assert.equal(signupMonitorDurationSeconds(70), 900);
  assert.equal(signupMonitorDurationSeconds(100), 900);
});

test("50 is the inclusive signup review notification floor", () => {
  const marker = signupReviewMarker({
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
  assert.equal(marker.payload.riskBand, "high");
  assert.equal(marker.payload.containmentRequired, false);
});

test("critical signup marker requires all three containment actions", () => {
  const marker = signupReviewMarker({
    userId: "user-critical",
    caseId: "case-critical",
    score: 70,
    signals: [],
  });
  assert.equal(marker.eventType, "critical_risk_signup");
  assert.equal(marker.sourceRef, "user-critical:critical_risk_signup");
  assert.equal(marker.payload.riskBand, "critical");
  assert.equal(marker.payload.containmentRequired, true);
  assert.equal(marker.payload.reasonCode, "critical_signup_score");
  assert.deepEqual(marker.payload.actions, [
    "lock_fiat_deposits",
    "lock_withdrawals",
    "lock_tips",
  ]);
});

test("score-21 signup delivery uses durable independent sinks", async () => {
  const source = await readFile(
    new URL("../src/monitor.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../migrations/014_signup_review_delivery.sql", import.meta.url),
    "utf8",
  );
  const lowRiskMigration = await readFile(
    new URL("../migrations/053_low_risk_signup_alerts.sql", import.meta.url),
    "utf8",
  );

  assert.match(source, /score >= HIGH_RISK_SIGNUP_SCORE/);
  assert.match(source, /INSERT INTO signup_alert_outbox/);
  assert.match(source, /INSERT INTO risk_events/);
  assert.match(source, /signupReviewMarker/);
  assert.match(source, /"High-risk signup"/);
  assert.match(source, /"Critical-risk signup"/);
  assert.match(source, /"Low-risk signup detected"/);
  assert.match(source, /"antifraud\.signup_low_risk"/);
  assert.match(source, /"antifraud\.signup_high"/);
  assert.match(source, /"antifraud\.signup_critical"/);
  assert.match(source, /caseId: lowRisk \? undefined/);
  assert.match(source, /LEFT JOIN subjects subject/);
  assert.match(source, /presentation: lowRisk \? undefined : "signup-risk"/);
  assert.match(source, /"Fiat deposits"/);
  assert.match(source, /"Crypto withdrawals"/);
  assert.match(source, /"Item withdrawals"/);
  assert.match(source, /"Tips"/);
  assert.doesNotMatch(source, /entered the critical signup band/);
  assert.match(source, /signals,/);
  assert.match(source, /deliverPendingSignupAlerts/);
  assert.match(migration, /CHECK \(score >= 60\)/);
  assert.match(lowRiskMigration, /CHECK \(score >= 21\)/);
  assert.match(migration, /FROM signup_assessments sa/);
  assert.match(migration, /'high_risk_signup'/);
  assert.match(migration, /WHERE discord_delivered_at IS NULL/);
});
