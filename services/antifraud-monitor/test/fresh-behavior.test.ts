import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isExpectedCreatorBehavior } from "../src/fresh-behavior.js";

test("creator exception is narrow and never suppresses identity behavior", () => {
  assert.equal(isExpectedCreatorBehavior(true, "fresh_creator_tip"), true);
  assert.equal(
    isExpectedCreatorBehavior(true, "fresh_sponsored_battle"),
    true,
  );
  assert.equal(isExpectedCreatorBehavior(true, "session_hopping"), false);
  assert.equal(isExpectedCreatorBehavior(true, "dormant_device_switch"), false);
  assert.equal(isExpectedCreatorBehavior(false, "fresh_creator_tip"), false);
});

test("global behavior scan is tuple-bounded and preserves provenance", async () => {
  const source = await readFile(
    new URL("../src/fresh-behavior.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /LIMIT \$3/);
  assert.match(source, /\(occurred_at, source \|\| ':' \|\| source_ref\) >/);
  assert.match(source, /promoCount30d/);
  assert.match(source, /creatorHasSiteRole/);
  assert.match(source, /deviceCount30m/);
  assert.match(source, /inactivityDays/);
  assert.match(source, /modelVersion: "behavior-v1"/);
  assert.match(source, /ON CONFLICT \(source, source_ref\)/);
  assert.match(source, /behavioral_withdrawal_containment/);
});

test("behavior policy is additive, capped, and uses signed containment", async () => {
  const [migration, monitor, ingest] = await Promise.all([
    readFile(
      new URL(
        "../migrations/041_fresh_account_behavior_policy.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../src/monitor.ts", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../../../src/app/api/antifraud/ingest/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)\b/i);
  assert.match(migration, /fresh-third-promo-redemption/);
  assert.match(migration, /fresh-minimum-withdrawal-runup/);
  assert.match(monitor, /LEAST\(100,GREATEST/);
  assert.match(monitor, /session\.initial_score - 30/);
  assert.match(ingest, /BEHAVIORAL_CONTAINMENT_REASONS/);
  assert.match(ingest, /locked_withdrawals_items = TRUE/);
  assert.doesNotMatch(ingest, /behavioral[\s\S]{0,500}kyc_required/i);
});
