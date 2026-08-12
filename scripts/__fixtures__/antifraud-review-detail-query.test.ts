import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(
  path.join(root, "src/lib/antifraud/reviews.ts"),
  "utf8",
);

test("review detail loads MAIN account context in one indexed round trip", () => {
  const start = source.indexOf("const contextResult = await main.execute");
  const end = source.indexOf("const context = contextResult.rows[0]", start);
  assert.notEqual(start, -1, "account-context query must exist");
  assert.notEqual(end, -1, "account-context query must consume its result");
  const query = source.slice(start, end);

  assert.equal(
    query.match(/main\.execute/g)?.length,
    1,
    "one case must occupy only one MAIN read-pool connection",
  );
  assert.match(query, /FROM \(VALUES \(/);
  assert.match(query, /LEFT JOIN "user" AS account/);
  assert.match(query, /LEFT JOIN user_feature_locks AS locks/);
  assert.match(query, /LEFT JOIN balances AS balance/);
  assert.equal(
    query.match(/FROM ledger_transactions/g)?.length,
    1,
    "fiat and crypto totals must share one ledger scan",
  );
  assert.equal(
    query.match(/SUM\(amount::numeric\) FILTER/g)?.length,
    2,
    "the shared scan must retain separate fiat and crypto totals",
  );
  assert.match(query, /type = 'deposit'/);
  assert.match(query, /status = 'completed'/);
});
