import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const querySource = readFileSync("src/lib/queries/races.ts", "utf8");
const actionSource = readFileSync(
  "src/app/(admin)/rewards/leaderboards/actions.ts",
  "utf8",
);

test("active and finalized race standings both overlay persisted claim holds", () => {
  assert.match(
    querySource,
    /async function getRaceClaimReviewByUser\([\s\S]*FROM race_claim_holds[\s\S]*released_at IS NULL/,
  );
  assert.equal(
    querySource.match(/getRaceClaimReviewByUser\(\{/g)?.length,
    2,
    "both the snapshot and live-monthly branches must load claim review state",
  );
  assert.equal(
    querySource.match(/hold: claimReview\.holdByUser\.get/g)?.length,
    2,
    "both standings mappers must display the persisted hold",
  );
  assert.doesNotMatch(
    querySource,
    /A running race has no finalized claims\/holds yet/,
  );
});

test("claim review state is fetched in one batch per standings page", () => {
  assert.match(querySource, /user_id = ANY\(\$3::text\[\]\)/);
  assert.doesNotMatch(
    querySource,
    /rows\.map\(async[\s\S]{0,300}getRaceClaimReviewByUser/,
  );
});

test("claim review overlays read primary for strict read-after-write", () => {
  const overlay = querySource.slice(
    querySource.indexOf("async function getRaceClaimReviewByUser"),
    querySource.indexOf("async function getDeposited28dByUser"),
  );
  assert.match(overlay, /await getPrimaryDrizzleDb\(\)/);
  assert.equal(overlay.match(/queryRows</g)?.length, 2);
  assert.doesNotMatch(overlay, /queryMainRows</);
});

test("freeze serializes against backend prize claims on the balance row", () => {
  const freeze = actionSource.slice(
    actionSource.indexOf("export async function freezeUserRaceClaim"),
    actionSource.indexOf("export async function unfreezeUserRaceClaim"),
  );
  assert.match(freeze, /await db\.transaction\(async \(tx\) =>/);
  assert.match(
    freeze,
    /\.from\(balances\)[\s\S]*\.where\(eq\(balances\.user_id, userId\)\)[\s\S]*\.for\("update"\)/,
  );

  const lockAt = freeze.indexOf(".from(balances)");
  const claimReadAt = freeze.indexOf(".from(race_claims)");
  const holdReadAt = freeze.indexOf(".from(race_claim_holds)");
  const holdInsertAt = freeze.indexOf("tx.insert(race_claim_holds)");
  assert.ok(lockAt >= 0 && lockAt < claimReadAt);
  assert.ok(claimReadAt < holdReadAt && holdReadAt < holdInsertAt);
  assert.doesNotMatch(freeze, /await db\s*\.select\(\{ id: race_claims\.id \}\)/);
});
