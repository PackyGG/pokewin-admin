import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const querySource = readFileSync("src/lib/queries/races.ts", "utf8");
const tableSource = readFileSync(
  "src/app/(admin)/rewards/leaderboards/standings-table.tsx",
  "utf8",
);

test("race standings batch completed deposits over a rolling 28-day window", () => {
  assert.match(querySource, /getDeposited28dByUser\(\s*userIds: string\[\]/);
  assert.match(querySource, /user_id = ANY\(\$1::text\[\]\)/);
  assert.match(querySource, /type = 'deposit'/);
  assert.match(querySource, /status = 'completed'/);
  assert.match(querySource, /NOW\(\) - INTERVAL '28 days'/);
  assert.match(querySource, /GROUP BY user_id/);
  assert.doesNotMatch(querySource, /rows\.map\(async .*getDeposited28dByUser/);
});

test("every race standings path returns and displays the 4-week deposit total", () => {
  assert.equal(
    querySource.match(/deposited28dUsd:\s*deposited28dByUser\.get/g)?.length,
    3,
  );
  assert.match(tableSource, /Deposited · 4w/);
  assert.match(tableSource, /formatCurrency\(e\.deposited28dUsd\)/);
  assert.match(tableSource, /formatCurrency\(s\.deposited28dUsd\)/);
});
