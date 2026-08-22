import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const querySource = fs.readFileSync(
  path.join(repoRoot, "src/lib/queries/eos-user-history.ts"),
  "utf8",
);
const actionSource = fs.readFileSync(
  path.join(repoRoot, "src/app/(admin)/eos/actions.ts"),
  "utf8",
);
const workspaceSource = fs.readFileSync(
  path.join(repoRoot, "src/app/(admin)/eos/eos-workspace.tsx"),
  "utf8",
);

test("EOS battle history reads bounded creator battles from the selected environment", () => {
  assert.match(querySource, /environment === "prod"[\s\S]*getProdReadDrizzleDb\(\)/);
  assert.match(querySource, /getBattleTestDevReadDrizzleDb\(\)/);
  assert.match(querySource, /b\.created_at >= now\(\) - interval '30 days'/);
  assert.match(querySource, /b\.currency::text = 'real'/);
  assert.match(querySource, /b\.user_id = \$1/);
  assert.match(querySource, /LIMIT \$2/);
  assert.match(querySource, /b\.eos_block_hash IS NOT NULL/);
});

test("EOS history and all-battles actions are access gated and merge monitor state", () => {
  assert.match(
    actionSource,
    /getEosUserBattleHistory[\s\S]*requireEosTestAccess\(\)[\s\S]*readDbEnvFromCookie\(\)/,
  );
  assert.match(
    actionSource,
    /loadEosBattles[\s\S]*requireEosTestAccess\(\)[\s\S]*readDbEnvFromCookie\(\)/,
  );
  assert.match(actionSource, /listEosSelectionSummaries\(environment, 50, userId\)/);
  assert.match(actionSource, /selectionSummary/);
  assert.match(workspaceSource, /value: "battles"/);
  assert.match(workspaceSource, /<EosBattles active=\{tab === "battles"\}/);
});
