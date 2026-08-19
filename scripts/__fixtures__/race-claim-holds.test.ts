import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const querySource = readFileSync("src/lib/queries/races.ts", "utf8");

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
