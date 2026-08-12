import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("creator reward history is bounded in SQL with totals kept as windows", () => {
  const detail = read("src/lib/queries/users-detail.ts");

  assert.match(detail, /COUNT\(\*\) OVER \(PARTITION BY c\.sent\)/);
  assert.match(
    detail,
    /ROW_NUMBER\(\) OVER \(\s*PARTITION BY c\.sent ORDER BY c\.created_at DESC/,
  );
  assert.match(detail, /WHERE tr\.row_num <= \$2/);
  assert.match(detail, /LEFT JOIN "user" u ON u\.id = tr\.counterparty_id/);
  assert.match(detail, /COUNT\(\*\) OVER \(PARTITION BY type\) AS type_count/);
  assert.match(detail, /WHERE row_num <= \$2/);
  assert.match(detail, /type = 'creator_tip'::ledger_transaction_type/);
  assert.match(detail, /AS tip_rows,/);
  assert.match(detail, /AS prize_rows/);
  assert.doesNotMatch(detail, /const \[rows, prizeRows\] = await Promise\.all/);
});

test("user detail consolidates small records and combines duplicate aggregates", () => {
  const detail = read("src/lib/queries/users-detail.ts");
  const progress = read("src/lib/queries/users-wager-progress.ts");

  assert.match(detail, /const corePromise = getUserDetailCore\(id\)/);
  assert.match(detail, /queryMainRows<UserDetailCoreRow\[]>/);
  assert.match(detail, /to_jsonb\(u\) \|\| jsonb_build_object/);
  assert.match(detail, /AS balances,/);
  assert.match(detail, /AS statistics,/);
  assert.match(detail, /AS feature_locks,/);
  assert.match(detail, /AS deposit_addresses,/);
  assert.doesNotMatch(
    detail,
    /SELECT \* FROM user_statistics WHERE user_id = \$1/,
  );
  assert.doesNotMatch(
    detail,
    /SELECT \* FROM affiliate_accounts WHERE user_id = \$1/,
  );
  assert.match(detail, /hasWagerProgressColumns\(\)/);
  assert.doesNotMatch(detail, /fetchWagerLocked/);
  assert.match(
    detail,
    /SUM\(amount::numeric\) FILTER \(\s*WHERE crypto_asset IS NULL/,
  );
  assert.match(detail, /type = 'deposit'::ledger_transaction_type/);
  assert.match(detail, /type = ANY\(\$2::ledger_transaction_type\[\]\)/);
  assert.match(progress, /export const hasWagerProgressColumns = cache/);
  assert.match(
    progress,
    /if \(!\(await hasWagerProgressColumns\(\)\)\) return null/,
  );
});

test("deposit figures share one ledger scan inside the consolidated query", () => {
  const detail = read("src/lib/queries/users-detail.ts");

  assert.match(detail, /deposit_agg AS \(/);
  assert.match(detail, /COUNT\(\*\) AS deposit_count/);
  assert.match(detail, /SUM\(amount::numeric\)::text AS deposit_total/);
  assert.match(detail, /AS fiat_deposit_total/);
  assert.match(detail, /CROSS JOIN deposit_agg da/);
  assert.equal(
    detail.match(/type = 'deposit'::ledger_transaction_type/g)?.length,
    1,
  );
});

test("referrer facts are resolved inside the existing user query", () => {
  const detail = read("src/lib/queries/users-detail.ts");

  assert.match(detail, /'referrer_context', \(/);
  assert.match(detail, /'signup_referral_code', \(/);
  assert.match(detail, /'latest_referral_code', \(/);
  assert.doesNotMatch(detail, /const \[referrer, signupUsage, latestUsage\]/);
});

test("critical route-key lookup is isolated from the analytics mirror pool", () => {
  const detail = read("src/lib/queries/users-detail.ts");

  assert.match(detail, /import \{ getPrimaryDrizzleDb \} from "@\/lib\/db"/);
  assert.match(
    detail,
    /queryRows<\{ id: string \}\[]>\(\s*await getPrimaryDrizzleDb\(\)/,
  );
  assert.match(detail, /users\.detail\.resolve\.primary/);
});
