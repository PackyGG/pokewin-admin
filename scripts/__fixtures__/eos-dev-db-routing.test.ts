import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("EOS user search follows the server-resolved dashboard environment", () => {
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
  assert.match(action, /readDbEnvFromCookie/);
  assert.match(action, /environment === "prod"/);
  assert.doesNotMatch(action, /config\.environment === "prod"/);
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

test("every EOS control request carries the server-selected environment", () => {
  const action = fs.readFileSync(
    path.join(repoRoot, "src/app/(admin)/eos/actions.ts"),
    "utf8",
  );
  const page = fs.readFileSync(
    path.join(repoRoot, "src/app/(admin)/eos/page.tsx"),
    "utf8",
  );
  const api = fs.readFileSync(
    path.join(repoRoot, "src/lib/antifraud/eos-test-config-api.ts"),
    "utf8",
  );

  assert.match(page, /getEosTestConfig\(environment\)/);
  assert.match(page, /listEosUserConfigs\(environment\)/);
  assert.match(action, /updateEosTestConfig\(environment,/);
  assert.match(action, /updateEosUserConfig\(environment,/);
  assert.match(action, /deleteEosUserConfig\(environment,/);
  assert.doesNotMatch(action, /environment:\s*z\./);
  assert.match(api, /x-pokewin-environment/);
  assert.match(api, /\[ENVIRONMENT_HEADER\]: environment/g);
  assert.match(api, /data\.environment !== environment/);
});
