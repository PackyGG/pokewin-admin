import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("withdrawal rows flag direct and sender-linked paid fiat funding", () => {
  const query = read("src/lib/queries/withdrawals.ts");

  assert.match(query, /own_fiat\.user_id = cwr\.user_id/);
  assert.match(query, /own_fiat\.paid_at IS NOT NULL/);
  assert.match(
    query,
    /sender_fiat\.user_id\s*=\s*NULLIF\(received_tip\.metadata->>'sender_user_id', ''\)/,
  );
  assert.match(query, /sender_fiat\.paid_at IS NOT NULL/);
  assert.match(query, /received_tip\.metadata->>'direction' = 'received'/);
  assert.match(query, /hasFiatFunding: w\.has_fiat_funding/);
});

test("withdrawal desktop and mobile rows render the red Fiat badge", () => {
  const columns = read("src/app/(admin)/withdrawals/columns.tsx");
  const table = read("src/app/(admin)/withdrawals/data-table.tsx");

  for (const source of [columns, table]) {
    assert.match(source, /hasFiatFunding/);
    assert.match(source, /bg-red-500\/15/);
    assert.match(source, />\s*Fiat\s*</);
  }
});
