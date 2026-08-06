import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CONTAINMENT_RECENCY_DAYS,
  classifyCreatorRisk,
  containmentRecencyEligible,
  crossedRiskBand,
  relationshipScoreForBattleCount,
  serializeCreatorRisks,
} from "../src/free-battle-risk.js";

const creator = {
  creator_kyc_required: false,
  creator_kyc_status: "none",
  creator_kyc_admin_decision: "pending",
  creator_kyc_reason: null,
  creator_is_suspected_alt: false,
};

test("ordinary compliance KYC does not mark a battle creator as fraudulent", () => {
  assert.equal(
    classifyCreatorRisk({
      ...creator,
      creator_kyc_required: true,
      creator_kyc_reason:
        "Lifetime fiat deposits reached $100.00 (current: $100.00)",
    }),
    null,
  );
});

test("fraud KYC, rejected KYC, alt flags, and active Antifraud scores are detected", () => {
  assert.deepEqual(
    classifyCreatorRisk({
      ...creator,
      creator_kyc_required: true,
      creator_kyc_reason:
        "Fiat deposit risk review: 87e65d49-1c35-4e57-a49a-c91402e245e2",
    }),
    {
      kind: "fraud_kyc_required",
      detail:
        "Fiat deposit risk review: 87e65d49-1c35-4e57-a49a-c91402e245e2",
      points: 40,
    },
  );
  assert.equal(
    classifyCreatorRisk({
      ...creator,
      creator_kyc_status: "rejected",
    })?.points,
    80,
  );
  assert.equal(
    classifyCreatorRisk({
      ...creator,
      creator_is_suspected_alt: true,
    })?.kind,
    "suspected_alt",
  );
  assert.equal(
    classifyCreatorRisk(creator, 60)?.kind,
    "antifraud_flagged",
  );
});

test("risk events emit only when evidence crosses a review band", () => {
  assert.equal(crossedRiskBand(0, 40), 40);
  assert.equal(crossedRiskBand(0, 80), 80);
  assert.equal(crossedRiskBand(40, 80), 80);
  assert.equal(crossedRiskBand(80, 100), 100);
  assert.equal(crossedRiskBand(100, 100), null);
});

test("two qualifying battles reach automatic containment regardless of creator count", () => {
  assert.equal(relationshipScoreForBattleCount(0), 0);
  assert.equal(relationshipScoreForBattleCount(1), 40);
  assert.equal(relationshipScoreForBattleCount(2), 80);
  assert.equal(relationshipScoreForBattleCount(3), 100);
  assert.equal(relationshipScoreForBattleCount(20), 100);
});

test("creator cursor input is serialized as JSON for the jsonb recordset", () => {
  const serialized = serializeCreatorRisks(new Map([
    ["creator-1", {
      kind: "fraud_kyc_required",
      detail: "scammer",
      points: 40,
    }],
  ]));
  assert.equal(typeof serialized, "string");
  assert.deepEqual(JSON.parse(serialized), [{
    creator_user_id: "creator-1",
    creator_risk_kind: "fraud_kyc_required",
    creator_risk_detail: "scammer",
    risk_points: 40,
  }]);
});

test("free-battle containment is durable and distinct-battle based", async () => {
  const source = await readFile(
    new URL("../src/free-battle-risk.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /COUNT\(DISTINCT battle_id\)::int AS battle_count/);
  assert.match(source, /battle_count < 2/);
  assert.match(source, /risky_free_battle_containment/);
  assert.match(source, /free-battle-containment:/);
  assert.match(source, /reconcileContainments/);
  assert.match(source, /containmentRequired: true/);
});

test("automated containment requires evidence inside the recency window", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 86_400_000);

  assert.equal(CONTAINMENT_RECENCY_DAYS, 7);
  // Live relationship: contain.
  assert.equal(containmentRecencyEligible(now, now), true);
  assert.equal(containmentRecencyEligible(daysAgo(1), now), true);
  assert.equal(
    containmentRecencyEligible(daysAgo(CONTAINMENT_RECENCY_DAYS - 0.01), now),
    true,
  );
  // The exact edge of the window still counts.
  assert.equal(
    containmentRecencyEligible(daysAgo(CONTAINMENT_RECENCY_DAYS), now),
    true,
  );
  // Historical cohort from the 30-day evidence lookback: evidence only, never an auto-lock.
  assert.equal(
    containmentRecencyEligible(daysAgo(CONTAINMENT_RECENCY_DAYS + 0.01), now),
    false,
  );
  assert.equal(containmentRecencyEligible(daysAgo(25), now), false);
  assert.equal(containmentRecencyEligible(daysAgo(30), now), false);
  // Timestamps arrive as Date from pg, but a string or a missing value must never open a lock.
  assert.equal(containmentRecencyEligible(daysAgo(2).toISOString(), now), true);
  assert.equal(containmentRecencyEligible(daysAgo(20).toISOString(), now), false);
  assert.equal(containmentRecencyEligible(null, now), false);
  assert.equal(containmentRecencyEligible(undefined, now), false);
  assert.equal(containmentRecencyEligible("not-a-date", now), false);
});

test("the recency gate is wired into both containment paths, and evidence keeps the full lookback", async () => {
  const source = await readFile(
    new URL("../src/free-battle-risk.ts", import.meta.url),
    "utf8",
  );
  const insert = source.slice(
    source.indexOf("private async insertContainmentEvent("),
    source.indexOf("private async reconcileContainments("),
  );
  // Single enforcement point: nothing reaches the risk_events insert without passing the gate.
  assert.match(
    insert,
    /if \(!containmentRecencyEligible\(evidence\.last_occurred_at\)\) \{[\s\S]*?return;\s*\}/,
  );
  assert.ok(
    insert.indexOf("containmentRecencyEligible") <
      insert.indexOf("INSERT INTO risk_events"),
    "the recency gate must run before the containment event is written",
  );
  // The reconcile sweep applies the same bound at the DB so historical-only cohorts are not
  // re-derived on every tick.
  const reconcile = source.slice(
    source.indexOf("private async reconcileContainments("),
  );
  assert.match(
    reconcile,
    /AND MAX\(match\.occurred_at\) >= now\(\) - \(\$1::text \|\| ' days'\)::interval/,
  );
  assert.match(reconcile, /\[CONTAINMENT_RECENCY_DAYS\]/);
  // Evidence collection itself is untouched: the cursor still seeds at the 30-day lookback.
  assert.match(source, /const INITIAL_LOOKBACK_DAYS = 30;/);
  assert.match(source, /now\(\) - \(\$2::text \|\| ' days'\)::interval/);
});

test("the containment detail no longer claims automated KYC", async () => {
  const source = await readFile(
    new URL("../src/free-battle-risk.ts", import.meta.url),
    "utf8",
  );
  // Behavioural containment sets crypto-withdrawal and item-shipping locks only; the ingest
  // route never sets kyc_required for it, so the operator copy must not say otherwise.
  assert.doesNotMatch(source, /Automatic KYC and withdrawal locks are required/);
  assert.match(
    source,
    /Automatic crypto-withdrawal and item-shipping locks are required; " \+\s*"KYC stays a staff decision\./,
  );
});

test("only accounts that actually own a battle become risky creators", async () => {
  const source = await readFile(
    new URL("../src/free-battle-risk.ts", import.meta.url),
    "utf8",
  );
  const riskCreators = source.slice(
    source.indexOf("private async riskCreators("),
    source.indexOf("private async syncCreatorCursors("),
  );
  // The direct source query filters non-creators out in SQL.
  assert.match(
    riskCreators,
    /AND EXISTS \(\s*\n\s*SELECT 1 FROM battles AS b WHERE b\.user_id = creator\.id\s*\n\s*\)/,
  );
  // Both additive Antifraud-DB sources go through the same ownership check before they can
  // become a cursor -- every cursor costs one MAIN query per tick in process().
  assert.match(riskCreators, /const owners = await this\.battleOwners\(/);
  assert.match(
    riskCreators,
    /if \(creators\.has\(userId\) \|\| !owners\.has\(userId\)\) continue;[\s\S]*kind: "antifraud_flagged"/,
  );
  assert.match(
    riskCreators,
    /if \(creators\.has\(userId\) \|\| !owners\.has\(userId\)\) continue;[\s\S]*kind: "network_cluster"/,
  );
  // The ownership probe itself is batched, not one query per candidate.
  const owners = source.slice(
    source.indexOf("private async battleOwners("),
    source.indexOf("private async syncCreatorCursors("),
  );
  assert.match(owners, /chunk\(unique, BATTLE_OWNER_LOOKUP_BATCH_SIZE\)/);
  assert.match(owners, /WHERE b\.user_id = ANY\(\$1::text\[\]\)/);
});

test("free-battle risk and fresh-behavior share one free/sponsored battle definition", async () => {
  const [freeBattle, freshBehavior] = await Promise.all([
    readFile(new URL("../src/free-battle-risk.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/fresh-behavior.ts", import.meta.url), "utf8"),
  ]);
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const clauses = [
    "sponsorship_percentage > 0",
    "source_session_id IS NOT NULL",
    "type::text = 'battle_bet'",
  ];
  const shared = normalize(
    freeBattle.slice(
      freeBattle.indexOf("const FREE_OR_SPONSORED_BATTLE_SQL"),
      freeBattle.indexOf("export type CreatorRiskKind"),
    ),
  );
  const fresh = normalize(freshBehavior);
  for (const clause of clauses) {
    assert.ok(
      shared.includes(clause),
      `free-battle-risk must qualify on ${clause}`,
    );
    assert.ok(
      fresh.includes(clause),
      `fresh-behavior must qualify on ${clause}`,
    );
  }
  // The shared expression is what fetchCandidates actually uses.
  assert.match(
    freeBattle,
    /\(\$\{FREE_OR_SPONSORED_BATTLE_SQL\}\s*\n\s*\) AS is_free_battle/,
  );
});

test("network-cluster membership only ever widens qualifying creators, never replaces the direct checks", async () => {
  const source = await readFile(
    new URL("../src/free-battle-risk.ts", import.meta.url),
    "utf8",
  );
  const riskCreators = source.slice(
    source.indexOf("private async riskCreators("),
    source.indexOf("private async syncCreatorCursors("),
  );

  // The direct KYC/suspected-alt/Antifraud-score source query and fold-in still run first and
  // unmodified.
  assert.match(
    riskCreators,
    /creator\.is_suspected_alt = true[\s\S]*OR kyc\.kyc_required = true/,
  );
  assert.match(riskCreators, /classifyCreatorRisk/);

  // Cluster evidence is folded in afterwards and only claims creators nothing else already
  // flagged -- it can never downgrade or overwrite a direct-evidence classification.
  assert.match(riskCreators, /listActiveNetworkClusterHighRiskMembers/);
  const clusterFoldIn = riskCreators.slice(
    riskCreators.indexOf("const clustered = await listActiveNetworkClusterHighRiskMembers"),
  );
  // `creators.has(userId)` still short-circuits first, so cluster evidence can never downgrade
  // or overwrite a direct-evidence classification. The added `owners` term only ever narrows.
  assert.match(
    clusterFoldIn,
    /if \(creators\.has\(userId\) \|\| !owners\.has\(userId\)\) continue;/,
  );
  assert.match(clusterFoldIn, /kind: "network_cluster"/);

  // The "one battle = evidence, two distinct qualifying battles = contain" threshold semantics
  // are untouched by this change.
  assert.match(source, /battle_count < 2/);
  assert.match(source, /HAVING COUNT\(DISTINCT match\.battle_id\) >= 2/);
});
