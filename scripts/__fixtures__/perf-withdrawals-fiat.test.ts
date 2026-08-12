import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Read-budget guardrails for /withdrawals and the Fiat tabs.
 *
 * Every MAIN read passes through the process-wide mirror admission semaphore
 * in `src/lib/db.ts`, which is sized to the mirror pool. What decides whether
 * a page paints or degrades to "Couldn't load this section" is therefore the
 * NUMBER of reads a render issues, not how fast any one of them is. These
 * tests pin the invariants that keep that number down, and the resilience
 * wiring that keeps one failed read from taking a whole route with it.
 *
 * Deliberately no tuning numbers here (pool size, permit count, timeout
 * budget) — those live in `src/lib/db.ts` / `safe-query.ts` and are free to
 * move. Only the structural invariants are pinned.
 *
 * Source is read from disk rather than imported: these modules are
 * `server-only` and reach the pg pool at import time.
 */
const read = (path: string) => readFileSync(path, "utf8");

test("the /withdrawals list read degrades in place instead of throwing the route away", () => {
  const page = read("src/app/(admin)/withdrawals/page.tsx");

  // The list query is the only read on the route. Awaited bare, a single
  // mirror-pool timeout escapes the segment and `error.tsx` replaces the whole
  // queue — hero, toolbar and filters included. It must go through safeQuery.
  assert.match(
    page,
    /safeQuery\(\s*\(\)\s*=>\s*\n?\s*getWithdrawals\(/,
    "getWithdrawals must be wrapped in safeQuery, not awaited bare",
  );
  assert.doesNotMatch(
    page,
    /await getWithdrawals\(/,
    "getWithdrawals must never be awaited outside safeQuery",
  );

  // A bounded wait is the half that catches a merely SLOW read; without a
  // timeout argument safeQuery only catches a throw.
  assert.match(
    page,
    /REWARD_QUERY_TIMEOUT_MS,/,
    "the wrapped list read must pass a timeout budget",
  );

  // A degraded read renders an error band, and the pagination line must say
  // "Results unavailable" rather than "0 results" — which reads as "your
  // filter matched nothing" next to an error notice.
  assert.match(page, /TileErrorFallback/);
  assert.match(page, /degraded/);
});

test("the Fiat webhooks tab spends one mirror read, not two", () => {
  const fiat = read("src/lib/queries/fiat.ts");

  const body = fiat.slice(
    fiat.indexOf("async function computeFiatWebhooks"),
    fiat.indexOf("const cachedFiatWebhooks"),
  );
  assert.ok(body.length > 0, "computeFiatWebhooks not found");

  const executes = body.match(/db\.execute</g)?.length ?? 0;
  assert.equal(
    executes,
    1,
    "the summary and the recent-failures list must stay folded into one statement",
  );

  // Both halves still have to be there — one statement is only a win if it
  // still answers both questions.
  assert.match(body, /FROM payment_webhook_events/);
  assert.match(body, /processing_status = 'failed'/);
  assert.match(body, /LIMIT 20/);

  // The original summary ordering sorted on `COUNT(*)::text`, i.e. a TEXT
  // sort. Casting it to a number here would silently reorder a rendered
  // table, so the json_agg ordering must stay on the text column.
  assert.match(body, /ORDER BY s\.events DESC, s\.event_type, s\.processing_status/);
});

test("FiatOverview computes nothing the Overview tab throws away", () => {
  const fiat = read("src/lib/queries/fiat.ts");
  const tabs = read("src/app/(admin)/fiat/_components/fiat-tabs.tsx");

  const typeBody = fiat.slice(
    fiat.indexOf("export type FiatOverview = {"),
    fiat.indexOf("export const EMPTY_FIAT_OVERVIEW"),
  );
  assert.ok(typeBody.length > 0, "FiatOverview type not found");

  const fields = [...typeBody.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(fields.length > 10, "FiatOverview field scan found too little");

  // Every field the statement pays for must reach the screen. Three counts
  // (fiat-locked users, fiat-locked locations, KYC-required users) used to be
  // computed here and rendered nowhere — the Access & holds tab derives the
  // same three itself. Re-adding a field without rendering it re-adds dead
  // scan work to a money-exact statement that already runs on a 15s budget.
  const unrendered = fields.filter(
    (field) => !new RegExp(`\\bdata\\.${field}\\b`).test(tabs),
  );
  assert.deepEqual(
    unrendered,
    [],
    `FiatOverview fields computed but never rendered: ${unrendered.join(", ")}`,
  );
});

test("the /withdrawals table skeletons reserve the real column count", () => {
  const columns = read("src/app/(admin)/withdrawals/columns.tsx");
  const page = read("src/app/(admin)/withdrawals/page.tsx");
  const loading = read("src/app/(admin)/withdrawals/loading.tsx");

  // Each column literal opens with either `accessorKey:` or `id:` at the
  // array's indentation level.
  const columnCount =
    columns.match(/^ {4}(accessorKey|id):/gm)?.length ?? 0;
  assert.ok(columnCount > 0, "could not count withdrawal columns");

  for (const [label, source] of [
    ["page Suspense fallback", page],
    ["loading.tsx", loading],
  ] as const) {
    const declared = Number(
      source.match(/<TableSkeleton rows=\{\d+\} columns=\{(\d+)\}/)?.[1],
    );
    assert.equal(
      declared,
      columnCount,
      `${label} skeleton must reserve ${columnCount} columns, not ${declared}`,
    );
  }
});
