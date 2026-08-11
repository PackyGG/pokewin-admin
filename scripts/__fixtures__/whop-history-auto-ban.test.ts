import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

test("Whop history auto-bans cross the durable signed containment boundary", () => {
  const detector = read("services/antifraud-monitor/src/whop-history-auto-bans.ts");
  const delivery = read("services/antifraud-monitor/src/ingest-delivery.ts");
  const outbox = read("src/lib/antifraud/containment-outbox.ts");
  const apply = read("src/lib/antifraud/whop-history-auto-ban.ts");

  assert.match(detector, /prior_dispute_count/);
  assert.match(detector, /prior_refund_count/);
  assert.match(detector, /ON CONFLICT \(source, source_ref\)/);
  assert.match(detector, /account\.is_banned = false/);
  assert.match(detector, /'admin','support','creator'/);
  assert.match(delivery, /whop_history_auto_ban/);
  assert.match(outbox, /whopHistoryAutoBanTarget/);
  assert.match(outbox, /applyWhopHistoryAutoBan/);
  assert.match(apply, /signal\.riskScore !== 100/);
  assert.match(apply, /containmentRequired !== true/);
  assert.match(apply, /is_banned = FALSE/);
  assert.match(apply, /DELETE FROM session/);
  assert.match(apply, /banned_by = NULL/);
});

test("confirmed automatic bans have a dedicated Discord route", () => {
  const alerts = read("services/antifraud-monitor/src/fiat-alerts.ts");
  const routes = read("services/antifraud-monitor/src/notification-routes.ts");
  const migration = read(
    "drizzle/admin/migrations/20260812_whop_history_auto_bans.sql",
  );
  const policy = read("src/lib/discord-notifications/antifraud-policy.ts");

  assert.match(alerts, /antifraud\.account_auto_banned/);
  assert.match(alerts, /problem_code = 'whop_history_auto_ban'/);
  assert.match(routes, /auto_banned/);
  assert.match(migration, /antifraud\.account_auto_banned/);
  assert.match(policy, /"auto-banned"/);
});

test("Fraud Admin exposes automatic-ban evidence and retry state", () => {
  const page = read("src/app/(antifraud)/antifraud/auto-bans/page.tsx");
  const query = read("src/lib/antifraud/auto-bans.ts");
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );

  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(page, /Whop-history automatic bans/);
  assert.match(query, /kind='whop_history_auto_ban'/);
  assert.match(query, /containment_outbox_status/);
  assert.match(query, /containment_outbox_error/);
  assert.match(sidebar, /label: "Auto Bans"/);
  assert.match(sidebar, /href: "\/antifraud\/auto-bans"/);
});
