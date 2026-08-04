import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("low-risk signups have a configurable Discord action without review", () => {
  const monitor = read("services/antifraud-monitor/src/monitor.ts");
  const policy = read("services/antifraud-monitor/src/signup-alerts.ts");
  const monitorMigration = read(
    "services/antifraud-monitor/migrations/053_low_risk_signup_alerts.sql",
  );
  const adminMigration = read(
    "drizzle/admin/migrations/20260804_low_risk_signup_discord_event.sql",
  );
  const splitMigration = read(
    "drizzle/admin/migrations/20260804_signup_risk_discord_split.sql",
  );

  assert.match(policy, /LOW_RISK_SIGNUP_SCORE = 21/);
  assert.match(policy, /HIGH_RISK_SIGNUP_SCORE = 50/);
  assert.match(monitor, /"antifraud\.signup_low_risk"/);
  assert.match(monitor, /"Low-risk signup detected"/);
  assert.match(monitor, /No staff review or automatic restriction was opened/);
  assert.match(monitor, /severity: lowRisk \? "low"/);
  assert.match(monitor, /caseId: lowRisk \? undefined/);
  assert.match(monitorMigration, /CHECK \(score >= 21\)/);
  assert.doesNotMatch(monitorMigration, /INSERT INTO signup_alert_outbox/);
  assert.match(adminMigration, /'antifraud\.signup_low_risk'/);
  assert.match(adminMigration, /'Signups'/);
  assert.match(splitMigration, /21-49 and entered a 5-minute monitor/);
  assert.doesNotMatch(adminMigration, /discord_notification_routes/);
});
