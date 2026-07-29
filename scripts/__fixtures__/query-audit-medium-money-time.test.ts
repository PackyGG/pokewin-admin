import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

test("race entrants use the same claimed race instances as the prize rollup", () => {
  const text = source("src/lib/queries/insights-rewards/race/per-type.ts");
  assert.match(text, /WITH races_in_window AS/);
  assert.match(text, /ri\.race_period_start = rls\.period_start/);
  assert.doesNotMatch(text, /rls\.period_start >=/);
});

test("affiliate funnel and cohort keep canonical casing, scope, and first-deposit semantics", () => {
  const performance = source(
    "src/lib/queries/insights-rewards/affiliate/code-performance.ts",
  );
  assert.match(performance, /UPPER\(acu\.code\) AS code/);
  assert.match(performance, /UPPER\(ac\.code\) AS code/);
  assert.match(performance, /role NOT IN \('admin', 'support', 'creator'\)/);

  const cohort = source(
    "src/lib/queries/insights-rewards/affiliate/cohort.ts",
  );
  assert.match(cohort, /ARRAY_AGG\([\s\S]*ORDER BY lt\.created_at ASC, lt\.id ASC/);
  assert.match(cohort, /role NOT IN \('admin', 'support', 'creator'\)/);
  assert.doesNotMatch(cohort, /MIN\(ABS\(lt\.amount/);
});

test("affiliate daily series uses the KPI rolling window and includes its partial oldest day", () => {
  const text = source(
    "src/lib/queries/insights-rewards/affiliate/overview.ts",
  );
  assert.match(text, /chartBucketCount = ctx\.days === null \? chartDays \+ 1 : ctx\.days \+ 1/);
  assert.match(text, /ctx\.dateFilterFor\("lt\.created_at"\)/);
  assert.match(text, /ctx\.dateFilterFor\("acu\.created_at"\)/);
});

test("dashboard period PnL includes every canonical correction", () => {
  const dashboard = source("src/lib/queries/dashboard.ts");
  assert.match(dashboard, /adminInventoryRemovalDisposedSql\(/);
  assert.match(dashboard, /adminVoucherRemovalClaimedSql\(/);
});
