import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("low-risk signup monitoring remains but its Discord action is retired", () => {
  const monitor = read("services/antifraud-monitor/src/monitor.ts");
  const policy = read("services/antifraud-monitor/src/signup-alerts.ts");
  const monitorMigration = read(
    "services/antifraud-monitor/migrations/053_low_risk_signup_alerts.sql",
  );
  const cleanupMigration = read(
    "drizzle/admin/migrations/20260812_discord_notification_routing_cleanup.sql",
  );
  const splitMigration = read(
    "drizzle/admin/migrations/20260804_signup_risk_discord_split.sql",
  );

  assert.match(policy, /LOW_RISK_SIGNUP_SCORE = 21/);
  assert.match(policy, /HIGH_RISK_SIGNUP_SCORE = 50/);
  assert.doesNotMatch(monitor, /"antifraud\.signup_low_risk"/);
  assert.doesNotMatch(monitor, /"Low-risk signup detected"/);
  assert.match(monitor, /Drain legacy 21-49 rows without posting/);
  assert.match(monitorMigration, /CHECK \(score >= 21\)/);
  assert.doesNotMatch(monitorMigration, /INSERT INTO signup_alert_outbox/);
  assert.match(cleanupMigration, /'antifraud\.signup_low_risk'/);
  assert.match(cleanupMigration, /SET enabled = false/);
  assert.match(splitMigration, /21-49 and entered a 5-minute monitor/);
  assert.match(cleanupMigration, /DELETE FROM discord_notification_routes/);
});
