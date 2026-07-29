import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

const consumers = ["src/lib/queries/crm.ts"] as const;

for (const consumer of consumers) {
  test(`${consumer} uses the canonical borrow-inclusive gaming legs`, () => {
    const source = read(consumer);

    assert.match(
      source,
      /from "@\/lib\/metrics\/gaming-sql"/,
      "the query must import the single canonical gaming-leg definition",
    );
    assert.match(source, /AND \$\{WAGER_LEG_FILTER\}/);
    assert.match(source, /AND \$\{PAYOUT_LEG_FILTER\}/);
    assert.doesNotMatch(source, /WAGER_NON_BORROW_FILTER/);
    assert.doesNotMatch(source, /PAYOUT_NON_BORROW_FILTER/);
    assert.doesNotMatch(source, /BORROW_FILTER_CTES/);
    assert.match(
      source,
      /NOT EXISTS \(\s*SELECT 1 FROM session_windows sw/,
      "creator-session filtering must remain in place",
    );
    assert.match(
      source,
      /realCustomersScopeSql/,
      "staff, creator, and blacklist scope must remain in place",
    );
  });
}
