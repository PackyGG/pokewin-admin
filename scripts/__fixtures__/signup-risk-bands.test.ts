import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("signup risk bands expose the agreed monitoring and staff actions", () => {
  const guide = read("src/app/(antifraud)/antifraud/guide/sign-up/page.tsx");
  const policy = read("services/antifraud-monitor/src/signup-alerts.ts");
  const bands = read("services/antifraud-monitor/src/score-catalog.ts");
  const ws = read("src/lib/antifraud/ws.ts");

  // The band boundaries the guide prints must be the ones the engine uses.
  // Guide renders them with an en dash; the catalog is the source of truth.
  assert.match(bands, /key: "low", label: "No risk", minimum: 0, maximum: 20/);
  assert.match(
    bands,
    /key: "medium", label: "Low risk", minimum: 21, maximum: 49/,
  );
  assert.match(
    bands,
    /key: "high", label: "High risk", minimum: 50, maximum: 69/,
  );
  assert.match(
    bands,
    /key: "critical", label: "Critical risk", minimum: 70, maximum: 100/,
  );
  for (const range of ["0 – 20", "21 – 49", "50 – 69", "70 – 100"]) {
    assert.ok(
      guide.includes(range),
      `signup guide is missing the ${range} band`,
    );
  }

  // Monitor durations.
  assert.match(policy, /return 5 \* 60/);
  assert.match(policy, /return 10 \* 60/);
  assert.match(policy, /return 15 \* 60/);
  for (const duration of ["5 minutes", "10 minutes", "15 minutes"]) {
    assert.ok(guide.includes(duration), `guide is missing ${duration}`);
  }

  // The two structural floors, pinned to their constants.
  assert.match(ws, /SIGNUP_REVIEW_SCORE_FLOOR = 50/);
  assert.match(guide, /label: "Review floor",\s*value: "50"/);
  assert.match(guide, /label: "Containment floor",\s*value: "70"/);
  assert.match(guide, /value: "start − 30"/);

  // The full critical containment set, and the fact that the other paths lock
  // less — an operator reading a locked account needs both halves.
  for (const lock of [
    "Fiat deposits",
    "Crypto withdrawals",
    "Item withdrawals",
    "Tip rewards",
  ]) {
    assert.ok(guide.includes(lock), `guide is missing the ${lock} lock`);
  }
  assert.match(guide, /The other containment paths lock less/);

  // Corrections that must not regress: the badge/name mismatch is stated, and
  // the window is documented as never extending.
  assert.match(guide, /Read the badge, not the name/);
  assert.match(guide, /It never extends/);
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
  const containment = read(
    "src/lib/antifraud/critical-signup-containment.ts",
  );

  assert.match(ingest, /isContainmentOutboxKind\(signal\.kind\)/);
  assert.match(ingest, /critical_risk_signup/);
  assert.match(containment, /"lock_fiat_deposits"/);
  assert.match(containment, /"lock_withdrawals"/);
  assert.match(containment, /"lock_tips"/);
  assert.match(containment, /locked_deposits_fiat = ARRAY\['all'\]::text\[\]/);
  assert.match(containment, /locked_withdrawals_crypto = ARRAY\['all'\]::text\[\]/);
  assert.match(containment, /locked_withdrawals_items = TRUE/);
  assert.match(containment, /updateUserRewardLocks/);
});
