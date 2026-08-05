import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("signup risk bands expose the agreed monitoring and staff actions", () => {
  const guide = read("src/app/(antifraud)/antifraud/guide/sign-up/page.tsx");
  const policy = read("services/antifraud-monitor/src/signup-alerts.ts");

  for (const range of ["0-20", "21-49", "50-69", "70-100"]) {
    assert.match(guide, new RegExp(`range: "${range}"`));
  }
  assert.match(policy, /return 5 \* 60/);
  assert.match(policy, /return 10 \* 60/);
  assert.match(policy, /return 15 \* 60/);
  assert.match(guide, /notification: "#high-risk"/);
  assert.match(guide, /notification: "#critical-risk"/);
  assert.match(guide, /notification: "Action available · No channel"/);
  assert.equal((guide.match(/review: "No"/g) ?? []).length, 2);
  assert.equal((guide.match(/review: "Yes"/g) ?? []).length, 2);
  assert.equal((guide.match(/locks: "None"/g) ?? []).length, 3);
  assert.match(
    guide,
    /locks: "Fiat deposits · Crypto withdrawals · Item withdrawals · Tips"/,
  );
  assert.doesNotMatch(
    guide,
    /Staff are informed|Nothing else happens|No automatic restriction/,
  );
  assert.match(guide, /title: "1\. Sign-up check"/);
  assert.match(guide, /title: "2\. Score it"/);
  assert.match(guide, /title: "3\. Monitor higher scores"/);
  assert.match(guide, /title: "4\. Apply the entry actions"/);
  assert.match(
    guide,
    /<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">/,
  );
  assert.match(guide, /title: "Open the window"/);
  assert.match(guide, /title: "Save the baseline"/);
  assert.match(guide, /title: "Collect fresh activity"/);
  assert.match(guide, /title: "Evaluate behavior flows"/);
  assert.match(guide, /title: "Close on the latest score"/);
  assert.match(guide, /value: "Initial -30"/);
  assert.match(guide, /value: "No restart"/);
  assert.match(guide, /clamp\(initial - 30, result, 100\)/);
  assert.doesNotMatch(
    guide,
    /A live score change is evidence, not a second signup/,
  );
  assert.doesNotMatch(guide, /Move up immediately/);
  assert.doesNotMatch(guide, /cross a higher threshold/);
  assert.doesNotMatch(guide, /Critical containment/);
});

test("high and critical signup actions own their Discord routes", () => {
  const migration = read(
    "drizzle/admin/migrations/20260804_signup_risk_discord_split.sql",
  );

  assert.match(migration, /'antifraud\.signup_high', '1534296433241493774'/);
  assert.match(
    migration,
    /'antifraud\.signup_critical', '1534296454129254523'/,
  );
  assert.match(migration, /parent_id = '1532207307683795026'/);
  assert.match(
    migration,
    /DELETE FROM discord_notification_routes\s+WHERE event_key = 'antifraud\.signup_high_risk'/,
  );
  assert.match(migration, /enabled = false/);
});

test("the duplicate need-review signup route is retired without touching review operations", () => {
  const migration = read(
    "drizzle/admin/migrations/20260804_retire_signup_need_review_route.sql",
  );
  const catalog = read(
    "src/app/(antifraud)/antifraud/settings/_lib/automation-catalog.ts",
  );

  assert.match(migration, /channel_id = '1532248557740884039'/);
  assert.match(migration, /event_key = 'antifraud\.review_opened'/);
  assert.match(migration, /enabled = false/);
  assert.doesNotMatch(migration, /antifraud\.review_reminder/);
  assert.doesNotMatch(migration, /antifraud\.account_(?:locked|banned)/);
  assert.doesNotMatch(migration, /antifraud\.kyc_required/);
  assert.doesNotMatch(catalog, /"antifraud\.review_opened"/);
  assert.match(catalog, /"antifraud\.review_reminder"/);
  assert.match(catalog, /"antifraud\.account_locked"/);
  assert.match(catalog, /"antifraud\.kyc_required"/);
});

test("critical signup containment requires and applies all three locks", () => {
  const ingest = read("src/app/api/antifraud/ingest/route.ts");

  assert.match(ingest, /signal\.kind === "critical_risk_signup"/);
  assert.match(ingest, /"lock_fiat_deposits"/);
  assert.match(ingest, /"lock_withdrawals"/);
  assert.match(ingest, /"lock_tips"/);
  assert.match(ingest, /locked_deposits_fiat = ARRAY\['all'\]::text\[\]/);
  assert.match(ingest, /locked_withdrawals_crypto = ARRAY\['all'\]::text\[\]/);
  assert.match(ingest, /locked_withdrawals_items = TRUE/);
  assert.match(ingest, /updateUserRewardLocks/);
});
