import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const ACQUISITION = "src/lib/queries/analytics-acquisition.ts";
const OUTBOX = "src/lib/antifraud/containment-outbox.ts";

test("the acquisition trend never computes first deposits over all history", () => {
  const query = source(ACQUISITION);
  const start = query.indexOf("first_deposits AS (");
  const end = query.indexOf("period_depositors AS (");
  assert.ok(start > 0 && end > start, "first_deposits CTE not found");
  const cte = query.slice(start, end);

  // Without this restriction the DISTINCT ON sorts every completed deposit
  // ever made before the outer query narrows to 7/30/90 days, which is what
  // exhausted the 15s budget and rendered the degraded banner.
  assert.match(cte, /AND lt\.user_id IN \(/);
  assert.match(cte, /w\.created_at >= b\.start_day AT TIME ZONE 'UTC'/);
});

test("deposit filters stay sargable so the partial deposit indexes can serve them", () => {
  const query = source(ACQUISITION);
  // `type::text = 'deposit'` cannot match idx_ledger_user_deposit_created or
  // idx_ledger_tx_deposit_created_at — casting the column defeats every index
  // on it.
  assert.doesNotMatch(query, /type::text\s*=\s*'deposit'/);
  assert.equal(
    query.match(/type = 'deposit'::ledger_transaction_type/g)?.length,
    3,
  );
});

test("a lost containment lease race is reported as deferred, not failed", () => {
  const outbox = source(OUTBOX);

  assert.match(
    outbox,
    /"locked"\s*\|\s*"skipped"\s*\|\s*"failed"\s*\|\s*"deferred"/,
  );
  const claimStart = outbox.indexOf("if (options.attemptAlreadyCounted !== true)");
  const applyStart = outbox.indexOf("const outcome = await applyContainmentForKind(signal);");
  assert.ok(claimStart > 0 && applyStart > claimStart);
  const claimBranch = outbox.slice(claimStart, applyStart);
  assert.match(claimBranch, /if \(claimed\.rows\.length === 0\) return "deferred";/);
  // The genuine failure token must still exist on the catch path.
  assert.match(outbox.slice(applyStart), /return "failed";/);
});
