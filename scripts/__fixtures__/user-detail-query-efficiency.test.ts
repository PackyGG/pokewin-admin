import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

/**
 * Slice out the consolidated core statement (`runUserDetailCoreQuery`'s SQL).
 *
 * "One scan" assertions must be scoped to that statement — `users-detail.ts`
 * legitimately contains other ledger reads (the tips/prizes query), and a
 * file-wide count would either be satisfied by them or broken by them.
 */
function coreStatement(detail: string): string {
  const start = detail.indexOf("queryMainRows<UserDetailCoreRow[]>(");
  assert.ok(start > 0, "the consolidated core statement must exist");
  const end = detail.indexOf("return row ?? null;", start);
  assert.ok(end > start, "could not delimit the consolidated core statement");
  return detail.slice(start, end);
}

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

  // `getUserDetailCore` now takes the resolved blacklist as a second argument,
  // so the call site is chained off that (ADMIN-DB, React-cached, never-throwing)
  // lookup instead of being a bare call. The invariant is unchanged: the page
  // gets its core record from EXACTLY ONE call to the consolidated statement,
  // awaited alongside the two heavy legs and nothing else.
  assert.match(
    detail,
    /const corePromise = [\s\S]{0,800}?getUserDetailCore\(\s*id,/,
  );
  assert.equal(
    detail.match(/getUserDetailCore\(/g)?.length,
    2,
    "getUserDetailCore must be declared once and called from exactly one site",
  );
  assert.match(
    detail,
    /await Promise\.all\(\[\s*corePromise,\s*userPnlPromise,/,
  );
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
  // The per-render `hasWagerProgressColumns()` capability probe is gone from the
  // detail path: the optional legs (`balances.wager_requirement_*`,
  // `user_battle_limits`) are emitted inline and the statement degrades ONCE on
  // undefined_table / undefined_column. Same protection as before — a schema-
  // lagging DB yields nulls instead of taking the page down — with no probe
  // round trip on the capped mirror pool. Pin the degrade path end to end.
  assert.match(detail, /withOptionalSchema/);
  assert.match(detail, /isPostgresError\(error, "42P01", "42703"\)/);
  assert.match(detail, /runUserDetailCoreQuery\(id, excludedUserIds, false\)/);
  assert.match(detail, /'wager_requirement_remaining', NULL::text/);
  assert.doesNotMatch(detail, /FROM information_schema/);
  assert.doesNotMatch(detail, /fetchWagerLocked/);
  assert.match(
    detail,
    /SUM\(lt\.amount::numeric\) FILTER \([\s\S]{0,200}?lt\.crypto_asset IS NULL/,
  );
  assert.match(detail, /type = 'deposit'::ledger_transaction_type/);
  // The lifetime wager breakdown used to be its own round trip bound to a
  // `type = ANY($2::ledger_transaction_type[])` parameter array. It is now three
  // FILTERs inside the shared aggregate, so what must stay true is that all
  // three wager types are still resolved TOGETHER, in a scan bounded by both
  // type and status so `idx_ledger_tx_user_type_status_created_at` still serves
  // it rather than the planner scanning the user's whole ledger.
  for (const wagerType of [
    "pack_opening",
    "battle_bet",
    "battle_sponsorship",
  ]) {
    assert.match(
      detail,
      new RegExp(`WHERE lt\\.type = '${wagerType}'::ledger_transaction_type`),
    );
  }
  assert.match(detail, /AND lt\.type IN \(/);
  assert.match(detail, /AND lt\.status = 'completed'::ledger_transaction_status/);
  assert.match(progress, /export const hasWagerProgressColumns = cache/);
  assert.match(
    progress,
    /if \(!\(await hasWagerProgressColumns\(\)\)\) return null/,
  );
});

test("deposit figures share one ledger scan inside the consolidated query", () => {
  const detail = read("src/lib/queries/users-detail.ts");
  const core = coreStatement(detail);

  // The CTE was `deposit_agg`; it is now `ledger_agg` because it also carries
  // the lifetime wager breakdown. Resolve its name from the CROSS JOIN instead
  // of hardcoding it — the old literal is exactly what churned, and a hardcoded
  // name that stops matching turns this pin into a silent no-op.
  const joined = core.match(/CROSS JOIN (\w+) (\w+)\b/);
  assert.ok(
    joined,
    "the core statement must CROSS JOIN its consolidated ledger aggregate",
  );
  const [, cteName, alias] = joined;
  assert.match(core, new RegExp(`\\b${cteName} AS \\(`));

  // THE invariant this test exists for: ONE scan of ledger_transactions inside
  // the whole core statement. Counting deposit predicates no longer expresses
  // it — the aggregate now carries several FILTERs over the same single scan —
  // so count the scans themselves.
  assert.equal(
    core.match(/FROM ledger_transactions/g)?.length,
    1,
    "the deposit aggregate and the wager breakdown must share ONE ledger scan",
  );

  // …and every derived figure is projected off that one aggregate rather than
  // recomputed, which is what makes the single scan sufficient.
  for (const column of [
    "deposit_count",
    "deposit_total",
    "fiat_deposit_total",
    "pack_opening_total",
    "battle_bet_total",
    "battle_sponsorship_total",
  ]) {
    assert.match(
      core,
      new RegExp(`\\b${alias}\\.${column}\\b`),
      `${column} must come from the shared ${cteName} aggregate`,
    );
  }
  assert.match(core, /\) AS deposit_count/);
  assert.match(core, /\)\)::text AS deposit_total/);
  assert.match(core, /AS fiat_deposit_total/);
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
