import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  KENO_DEFAULT_MAX_BET_USD,
  KENO_DEFAULT_MAX_WIN_USD,
  KENO_MAX_CONFIGURABLE_BET_USD,
  KENO_MIN_BET_USD,
} from "@/lib/keno/payouts";

const repoRoot = process.cwd();
const source = (path: string) =>
  readFileSync(`${repoRoot}/${path}`, "utf8");

test("Keno bet and win defaults mirror the backend contract", () => {
  assert.equal(KENO_MIN_BET_USD, 0.25);
  assert.equal(KENO_DEFAULT_MAX_BET_USD, 20);
  assert.equal(KENO_DEFAULT_MAX_WIN_USD, 20_000);
  assert.equal(KENO_MAX_CONFIGURABLE_BET_USD, 1_000);
});

test("Keno config reads and writes through the dedicated backend endpoint", () => {
  const api = source("src/lib/backend-api/keno-config.ts");
  const action = source("src/app/(admin)/keno/actions.ts");

  assert.match(api, /\.get<Success<KenoConfig>>\("\/admin\/keno-config"\)/);
  assert.match(
    api,
    /\.put<Success<KenoConfig>>\("\/admin\/keno-config", input\)/,
  );
  assert.match(action, /requirePageAccess\("\/keno"\)/);
  assert.match(action, /eventType: "keno_config_updated"/);
  assert.match(action, /max_win_usd: z\.number\(\)\.finite\(\)\.positive\(\)/);
  assert.match(action, /revalidateTag\(KENO_CONFIG_CACHE_TAG\)/);
});

test("Keno Configuration owns the live bet and win caps and hides their raw keys", () => {
  const tab = source(
    "src/app/(admin)/keno/_components/configuration-tab.tsx",
  );
  const card = source(
    "src/app/(admin)/keno/_components/keno-settings-card.tsx",
  );
  const security = source(
    "src/app/(admin)/security/security-sections-loader.tsx",
  );
  const keys = source("src/app/(admin)/keno/config-keys.ts");

  assert.match(tab, /getCachedKenoConfig\(\)/);
  assert.match(tab, /kenoConfig=\{kenoConfig\}/);
  assert.match(card, /updateKenoConfigAction\(/);
  assert.match(card, /keno_max_bet_usd/);
  assert.match(card, /keno_max_win_usd/);
  assert.match(card, /All 5 active settings/);
  assert.match(keys, /"keno_max_bet_usd"/);
  assert.match(keys, /"keno_max_win_usd"/);
  assert.match(security, /\.\.\.KENO_SITE_CONFIG_KEYS/);
});
