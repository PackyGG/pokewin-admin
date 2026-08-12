import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runWithConcurrency } from "../../src/lib/promise-pool";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relative: string) =>
  readFileSync(path.join(root, relative), "utf8");

/**
 * A rejected batch used to keep running. `Promise.all` rejects on the first
 * failure, but the sibling worker kept pulling tasks, so their queries ran on
 * to completion — or to the 30s statement_timeout — holding one of the two
 * MAIN mirror slots for a render whose result had already been discarded.
 *
 * The pre-existing promise-pool fixture only covers concurrency 1, where a
 * single worker unwinds on its own throw. The leak needed a second worker.
 */
test("runWithConcurrency stops pulling work in EVERY worker after a rejection", async () => {
  const started: number[] = [];
  const tasks = [
    async () => {
      started.push(0);
      throw new Error("boom");
    },
    async () => {
      started.push(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 1;
    },
    async () => {
      started.push(2);
      return 2;
    },
  ] as const;

  await assert.rejects(() => runWithConcurrency(tasks, 2), /boom/);
  assert.deepEqual(
    started,
    [0, 1],
    "the surviving worker must not pick up task 2 after the batch failed",
  );
});

/**
 * An incomplete snapshot is deliberately never written under the main key, so
 * one permanently-slow leg meant nothing was EVER cached and every request
 * re-paid the aggregate fan-out — which is what keeps the mirror pool saturated
 * and that leg slow. The short served-snapshot window breaks the loop; the
 * invariant it must not break is that a partial never lands on the main key.
 */
test("the dashboard trend fan-out is relieved without caching a partial over the good snapshot", () => {
  const source = read("src/lib/queries/dashboard-trend-series.ts");

  assert.match(source, /const TREND_SERVED_SNAPSHOT_TTL_SECONDS = \d+;/);
  assert.match(
    source,
    /cacheGetOrSet\(\s*`\$\{key\}:served`/,
    "the served snapshot must use its own key, never the main one",
  );
  // The completeness gate on the main key stays exactly where it was.
  assert.match(source, /snapshot was incomplete/);
  assert.match(source, /cacheGetOrSetStale\(\s*\n?\s*key,\s*\n?\s*60,/);
});

/**
 * `under_creator` has one value per user. As a correlated EXISTS in an inlined
 * CTE's target list the SubPlan is pulled up into the join and re-evaluated per
 * WAGER EVENT instead of per customer. A join computes it once; `ref.id` is the
 * primary key, so it can never duplicate a wager row or move the numbers.
 */
test("wager attribution resolves creator referral by join, not by a per-row subplan", () => {
  const source = read("src/lib/queries/dashboard-trend-series.ts");
  const customersCte = source.slice(
    source.indexOf("WITH customers AS MATERIALIZED ("),
    source.indexOf("), events AS ("),
  );

  assert.ok(customersCte.length > 0, "the customers CTE must still exist");
  assert.doesNotMatch(
    customersCte,
    /EXISTS \(/,
    "the correlated EXISTS must not come back",
  );
  assert.match(customersCte, /LEFT JOIN "user" ref/);
  assert.match(customersCte, /\(ref\.id IS NOT NULL\) AS under_creator/);
  // The blacklist fragment is a bare `id` predicate, so `"user"` has to stay
  // alone in the scope it is interpolated into or the query fails as ambiguous.
  assert.match(
    customersCte,
    /SELECT id, referred_by\s*\n\s*FROM "user"\s*\n\s*WHERE role NOT IN \('admin', 'support', 'creator'\) \$\{blacklistIdNotIn\}/,
  );
});

/**
 * The deposits feed read a user's ENTIRE login history per row —
 * `array_agg(... ORDER BY ...)` built only to read element [1] — for accounts
 * that can have thousands of auth events.
 */
test("the fiat deposits feed takes the newest auth row instead of aggregating the whole history", () => {
  const source = read("src/lib/antifraud/fiat-deposits-overview.ts");

  assert.doesNotMatch(
    source,
    /array_agg\(host\(audit\.ip\)/,
    "the per-row login-history aggregate must not come back",
  );
  assert.match(source, /\) signup ON TRUE/);
  assert.match(source, /\) latest_auth ON TRUE/);
  assert.match(source, /ORDER BY audit\.created_at DESC\s*\n\s*LIMIT 1/);
  // Both fields must still come from the same newest row with an IP, which is
  // what the two same-ordered aggregates used to guarantee.
  assert.match(
    source,
    /SELECT host\(audit\.ip\) AS latest_auth_ip,\s*\n\s*audit\.event_type::text AS latest_auth_event/,
  );
});

/**
 * A retried auto-ban whose outcome write was lost reported `skipped` with a
 * NULL applied time for an account that really is banned. Only this
 * automation's own ban may be re-claimed: `banned_by IS NULL` plus the exact
 * reason string (it carries the payment id) can never match a human ban.
 */
test("a retried Whop auto-ban recognises its own earlier ban", () => {
  const source = read("src/lib/antifraud/whop-history-auto-ban.ts");

  assert.match(source, /AND is_banned = TRUE/);
  assert.match(source, /AND banned_by IS NULL/);
  assert.match(source, /AND banned_reason = \$\{target\.reason\}/);
  assert.match(
    source,
    /if \(priorAutoBan\.rows\.length !== 1\) return "skipped";/,
  );
  // The guarded UPDATE and the session revoke stay exactly as they were.
  assert.match(source, /AND is_banned = FALSE/);
  assert.match(source, /DELETE FROM session/);
});

/**
 * pg-pool arms `connectionTimeoutMillis` on the QUEUE WAIT as well as the TCP
 * connect. An acquire budget below `statement_timeout` means one slow Admin
 * query starves every sibling queued behind it — including the `verifySession`
 * read on every request — with `timeout exceeded when trying to connect`, which
 * is not a query timeout and has no page-level fallback.
 */
test("the Admin pool acquire budget outlasts its worst permitted statement", () => {
  const source = read("src/lib/admin-db.ts");

  const acquire = source.match(/connectionTimeoutMillis: ([\d_]+)/);
  const statement = source.match(/statement_timeout: ([\d_]+)/);
  assert.ok(acquire && statement, "both pool budgets must be declared");

  const acquireMs = Number(acquire[1].replaceAll("_", ""));
  const statementMs = Number(statement[1].replaceAll("_", ""));
  assert.ok(
    acquireMs > statementMs,
    `admin acquire budget (${acquireMs}ms) must exceed statement_timeout ` +
      `(${statementMs}ms), otherwise a queued waiter can never outlive the ` +
      `statement ahead of it`,
  );
});
