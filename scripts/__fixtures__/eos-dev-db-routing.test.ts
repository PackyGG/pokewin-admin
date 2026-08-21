import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("EOS user search follows the monitor environment using read-only databases", () => {
  const action = fs.readFileSync(
    path.join(repoRoot, "src/app/(admin)/eos/actions.ts"),
    "utf8",
  );
  const database = fs.readFileSync(
    path.join(repoRoot, "src/lib/battle-test-dev-db.ts"),
    "utf8",
  );

  assert.match(action, /getBattleTestDevReadDrizzleDb/);
  assert.match(action, /getProdReadDrizzleDb/);
  assert.match(action, /config\.environment === "prod"/);
  assert.doesNotMatch(action, /getDevReadDrizzleDb/);
  assert.match(database, /BATTLE_TEST_DEV_DATABASE_URL/);
  assert.match(database, /default_transaction_read_only=on/);
  assert.match(database, /MIRROR_PRODUCTION_DB/);
  assert.match(database, /DATABASE_URL_POOLED/);
  assert.doesNotMatch(
    database,
    /BATTLE_TEST_DEV_DATABASE_URL[^;\n]*\?\?[^;\n]*(?:MIRROR|DATABASE)_/,
  );
});
