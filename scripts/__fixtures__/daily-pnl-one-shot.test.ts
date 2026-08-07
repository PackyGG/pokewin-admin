import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(
  path.join(process.cwd(), "src/lib/queries/pnl.ts"),
  "utf8",
);

test("daily P&L cache fills use one MAIN pool slot", () => {
  const start = source.indexOf("async function computeDailyPnl(");
  const end = source.indexOf("const cachedDailyPnl = unstable_cache(", start);
  assert.ok(start >= 0 && end > start, "computeDailyPnl source block missing");

  const block = source.slice(start, end);
  assert.equal(
    block.match(/queryMainRows</g)?.length,
    1,
    "daily P&L must stay a single PostgreSQL statement",
  );
  assert.match(block, /WITH ledger AS \(/);
  assert.match(block, /, legs AS \(/);
  assert.doesNotMatch(block, /Promise\.all\(/);
  assert.match(source, /dashboard-daily-pnl-v4-one-shot/);
});
