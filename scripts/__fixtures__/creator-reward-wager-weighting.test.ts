import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("creator rewards use the wager's frozen leaderboard weight", () => {
  const compute = readFileSync("src/lib/creator-vip/compute.ts", "utf8");
  const queryStart = compute.indexOf("function wagerPositionSql(");
  const queryEnd = compute.indexOf("function parseWagerPosition(");

  assert.ok(queryStart >= 0, "wagerPositionSql must remain present");
  assert.ok(queryEnd > queryStart, "the wager position query must remain bounded");
  const wagerQuery = compute.slice(queryStart, queryEnd);

  const effectiveWager = wagerQuery.match(
    /COALESCE\(\s*acu\.weighted_wager_amount_usd,\s*0\s*\)(?:::numeric)?\s+AS\s+(\w+)/,
  );
  assert.ok(
    effectiveWager,
    "creator rewards must use the frozen weighted wager and fail closed when it is missing",
  );

  assert.doesNotMatch(
    wagerQuery,
    /acu\.wager_amount_usd/,
    "creator rewards must never read or expose the original unweighted wager",
  );

  const effectiveAlias = effectiveWager[1];
  const summedEffectiveWager = new RegExp(
    `SUM\\(live\\.${effectiveAlias}(?:::\\w+)?\\)`,
    "g",
  );
  assert.equal(
    wagerQuery.match(summedEffectiveWager)?.length,
    2,
    "both current-run and lifetime reward progress must sum the effective weighted wager",
  );
});
