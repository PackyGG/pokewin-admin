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

test("network-cluster membership is an additive score input, not a new containment path", async () => {
  const source = await readFile(
    new URL("../src/fresh-behavior.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /import { findNetworkClusterHighRiskMembers } from "\.\/network-risk\.js";/);
  assert.match(source, /await this\.applyNetworkClusterSignal\(candidates\)/);

  const signalMethod = source.slice(
    source.indexOf("private async applyNetworkClusterSignal("),
    source.indexOf("private async persist("),
  );
  // It only ever raises score, never assigns or reads containment_required -- that stays
  // governed purely by event_type in the SQL above, exactly as before.
  assert.doesNotMatch(signalMethod, /containment_required/);
  assert.match(signalMethod, /candidate\.score = Math\.min\(100, candidate\.score \+ NETWORK_CLUSTER_SCORE_BONUS\)/);
  assert.match(signalMethod, /networkClusterFlagged: true/);

  // Sender-side membership (the only cross-account subject this file already looks at, via
  // senderRestricted) is checked in addition to the primary subject, not instead of it.
  assert.match(signalMethod, /candidate\.payload\?\.senderUserId/);
  assert.match(signalMethod, /clustered\.has\(candidate\.user_id\)/);
});
