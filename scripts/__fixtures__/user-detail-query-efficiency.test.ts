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
  assert.match(detail, /WHERE r\.row_num <= \$2/);
  assert.match(detail, /LEFT JOIN "user" u ON u\.id = r\.counterparty_id/);
  assert.match(detail, /COUNT\(\*\) OVER \(PARTITION BY type\) AS type_count/);
  assert.match(detail, /WHERE row_num <= \$2/);
  assert.match(detail, /type = 'creator_tip'::ledger_transaction_type/);
});

test("user detail reuses balance capability and combines duplicate aggregates", () => {
  const detail = read("src/lib/queries/users-detail.ts");
  const progress = read("src/lib/queries/users-wager-progress.ts");

  assert.match(detail, /const balancesPromise = getUserDetailBalances\(id\)/);
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

test("referrer facts are resolved inside the existing user query", () => {
  const detail = read("src/lib/queries/users-detail.ts");

  assert.match(detail, /AS referrer_context/);
  assert.match(detail, /AS signup_referral_code/);
  assert.match(detail, /AS latest_referral_code/);
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
