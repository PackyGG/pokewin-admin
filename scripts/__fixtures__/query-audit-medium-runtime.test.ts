import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("affiliate cohort binds text ids without uuid casts", () => {
  const source = read(
    "src/lib/queries/insights-rewards/affiliate/cohort.ts",
  );

  assert.match(
    source,
    /topAffiliates\.map\(\(affiliate\) => sql`\$\{affiliate\.affiliate_user_id\}`\)/,
  );
  assert.doesNotMatch(source, /affiliate\.affiliate_user_id\}::uuid/);
});

test("deposit bonus histogram gives numeric types to bound division", () => {
  const source = read(
    "src/lib/queries/insights-rewards/deposit-bonus/cap-analysis.ts",
  );

  assert.match(
    source,
    /\$\{capLiteral\}::numeric \/ \$\{HISTOGRAM_BUCKETS\}::numeric/,
  );
  assert.match(source, /0::numeric/);
});

test("expiry query emits its reviewed select fragment as SQL", () => {
  const source = read("src/lib/queries/insights-rewards/expiry.ts");

  assert.match(source, /\$\{sql\.raw\(expSelect\)\}/);
  assert.doesNotMatch(source, /display_name, \$\{expSelect\}, enabled/);
});

test("invalid transaction type filters return an empty result", () => {
  const source = read("src/lib/queries/users-transactions.ts");

  assert.match(source, /let requestedTypeFilterIsEmpty = false;/);
  assert.match(
    source,
    /if \(requestedTypeFilterIsEmpty\) \{[\s\S]*?total: 0,[\s\S]*?totalPages: 0/,
  );
});

test("synthetic double-down rows share type status and date filters", () => {
  const source = read("src/lib/queries/users-transactions.ts");
  const helper = source.slice(
    source.indexOf("function doubleDownWhereSql"),
    source.indexOf("async function fetchLedgerRowsByIds"),
  );

  assert.match(helper, /filter\.types\.includes\("battle_bet"\)/);
  assert.match(helper, /filter\.status !== "completed"/);
  assert.match(helper, /filter\.dateFrom/);
  assert.match(helper, /filter\.dateTo/);
  assert.equal(
    (source.match(/WHERE \$\{doubleDownWhere\}/g) ?? []).length,
    2,
  );
});

test("profile referral KPI uses an uncapped distinct count", () => {
  const source = read("src/lib/queries/my-profile.ts");

  assert.match(
    source,
    /SELECT COUNT\(DISTINCT referred_user_id\)::text AS total[\s\S]*?FROM affiliate_code_usages/,
  );
  assert.match(source, /totalReferred,\s*\n/);
  assert.doesNotMatch(source, /totalReferred: referrals\.length/);
});
