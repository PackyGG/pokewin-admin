import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/(admin)/users/[id]/page.tsx", "utf8");
const freshBalances = readFileSync(
  "src/app/(admin)/users/[id]/fresh-balances.ts",
  "utf8",
);
const detailCache = readFileSync(
  "src/lib/queries/users-detail-cache.ts",
  "utf8",
);

test("balance box uses an uncached primary consistency read", () => {
  assert.match(freshBalances, /getPrimaryDrizzleDb/);
  assert.match(freshBalances, /queryRows<Row\[]>/);
  assert.doesNotMatch(freshBalances, /unstable_cache|readDrizzleForEnv/);
  assert.match(freshBalances, /officialStreamAdjustmentSqlPredicate/);
  assert.match(freshBalances, /removeLockedBalanceAdjustmentSqlPredicate/);
  assert.match(page, /readFreshUserBalances\(id\)/);
  assert.match(
    page,
    /data\.balances && freshBalancesResult\.data[\s\S]*\.\.\.freshBalancesResult\.data/,
  );
});

test("Gaming initial activity is uncached and limited to 10 rows", () => {
  assert.match(
    page,
    /getUserTransactions\(id, 1, 10, \{ types: GAMING_TYPES \}\)/,
  );
  assert.doesNotMatch(page, /getUserGamingTransactionsCached/);
  assert.doesNotMatch(detailCache, /function cachedUserGamingTransactions/);
});
