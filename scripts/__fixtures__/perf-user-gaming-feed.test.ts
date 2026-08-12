import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(
  path.join(process.cwd(), "src/lib/queries/users-transactions.ts"),
  "utf8",
);

test("gaming timeline pages and counts in one normal-path scan", () => {
  const gamingStart = source.indexOf("const rawOffset =");
  const timelineStart = source.indexOf("WITH timeline AS (", gamingStart);
  const timeline = source.slice(
    timelineStart,
    source.indexOf("const ledgerIds =", timelineStart),
  );

  assert.match(timeline, /COUNT\(\*\) OVER \(\)::text AS total/);
  assert.match(timeline, /rawOffset > 0/);
  assert.equal(
    (timeline.match(/FROM ledger_transactions lt WHERE \$\{where\}/g) ?? [])
      .length,
    1,
    "the second timeline scan must exist only in the empty-page fallback",
  );
});

test("held-value snapshots materialize one user history per page", () => {
  const snapshots = source.slice(
    source.indexOf("WITH tx AS MATERIALIZED ("),
    source.indexOf("const { inventoryItems, cards }"),
  );

  assert.match(snapshots, /holdings AS MATERIALIZED/);
  assert.match(source, /ledgerIds\.length > 0/);
  assert.match(source, /pageGameSessionIds\.length > 0/);
  assert.match(snapshots, /GROUP BY tx\.id, tx\.created_at/);
  assert.doesNotMatch(snapshots, /LEFT JOIN LATERAL/);
  assert.equal((snapshots.match(/FROM user_inventory ui/g) ?? []).length, 1);
  assert.equal((snapshots.match(/FROM vouchers v/g) ?? []).length, 1);
});
