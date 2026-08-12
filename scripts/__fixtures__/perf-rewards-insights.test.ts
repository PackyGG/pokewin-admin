import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Read-budget guardrails for /rewards and the insights query layer that
 * /analytics?tab=rewards + ?tab=cost-breakdown render from.
 *
 * Every MAIN read passes through the process-wide mirror admission semaphore
 * in `src/lib/db.ts`, sized to the mirror pool. Whether a tile paints or
 * degrades to "Couldn't load this section" is therefore decided by the NUMBER
 * of reads one render issues and by how many of them sit in SERIES, not by how
 * fast any single statement is. These tests pin the structural invariants that
 * keep both numbers down.
 *
 * No tuning numbers are pinned here (pool size, permit count, timeout budget) —
 * those live in `src/lib/db.ts` / `safe-query.ts` and are free to move.
 *
 * Source is read from disk rather than imported: these modules are
 * `server-only` and reach the pg pool at import time.
 */
/** Normalised to LF so the assertions below are checkout-agnostic (Windows). */
const read = (path: string) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const DAILY_PACKS = "src/lib/queries/insights-rewards/daily-packs.ts";
const PROGRAM_SPEND = "src/lib/queries/insights-rewards/program-spend.ts";
const CROSS_SUMMARY =
  "src/lib/queries/insights-rewards/cross-category-summary.ts";
const COST_BREAKDOWN = "src/lib/queries/insights-analytics/cost-breakdown.ts";
const PROMO_TAB = "src/app/(admin)/rewards/promo-codes-tab.tsx";

/** How many statements a module hands to the mirror per compute call. */
function queryCount(source: string): number {
  return source.match(/queryRows</g)?.length ?? 0;
}

test("daily-pack giveaway is ONE round trip, not one per result set", () => {
  const source = read(DAILY_PACKS);

  // The per-pack rollup, the top-line totals and the daily series all read the
  // same `reward_cards` join (user_inventory ⋈ game_sessions ⋈ packs, minus the
  // creator-session windows). Split across separate statements the mirror pays
  // for that join once per statement AND each takes its own admission permit.
  assert.equal(
    queryCount(source),
    1,
    "daily-packs must issue exactly one statement — keep the per-pack, totals " +
      "and daily aggregations as branches of the single reward_cards CTE",
  );

  // The single statement only stays cheap while the shared scan is a CTE the
  // branches reference; inlining it back into each branch would restore the
  // triple scan without changing the statement count.
  assert.match(source, /reward_cards AS \(/);
  for (const branch of ["per_pack AS (", "per_day AS ("]) {
    assert.ok(
      source.includes(branch),
      `expected the ${branch} branch to read from the shared CTE`,
    );
  }
});

test("program spend reads the ledger once per scope, and daily packs ride along", () => {
  const source = read(PROGRAM_SPEND);

  // Two scopes are genuinely different populations (customer scope for the
  // reward leaves, blacklist-only for the house-funded creator pool), so two
  // statements is the floor. The rollup and the daily series within each scope
  // must NOT split back into separate scans.
  assert.ok(
    queryCount(source) <= 2,
    `program-spend must issue at most two statements, found ${queryCount(source)}`,
  );

  // The daily-pack read is independent of both sweeps. Awaited afterwards it
  // adds a whole extra serial leg to the tab's critical path.
  assert.doesNotMatch(
    source,
    /await getDailyPacksGiveaway\(/,
    "getDailyPacksGiveaway must resolve inside the Promise.all, not after it",
  );
  assert.match(source, /getDailyPacksGiveaway\(period\),\n\s*\]\);/);
});

test("the cross-category summary batches its window reads instead of chaining them", () => {
  const source = read(CROSS_SUMMARY);

  // Current window, prior-equal window and the daily-pack cost are mutually
  // independent; chaining them tripled the wall-clock the KPI strip waits for.
  assert.doesNotMatch(
    source,
    /await getDailyPacksTotalCost\(/,
    "getDailyPacksTotalCost must resolve inside the Promise.all",
  );
  assert.match(
    source,
    /const \[currentRows, priorRows, dailyPacks\] = await Promise\.all\(\[/,
    "the two window scans and the daily-pack cost must share one Promise.all",
  );

  // Lifetime has no prior frame — it must not pay for a second scan to learn
  // that. (The prior leg resolves to an empty result set instead.)
  assert.match(source, /priorDateClause === null\s*\n?\s*\?\s*Promise\.resolve/);
});

test("the cost-breakdown waterfall keeps its grouped ledger sums in the batch", () => {
  const source = read(COST_BREAKDOWN);

  assert.doesNotMatch(
    source,
    /await sumLedgerTypesGrouped\(/,
    "sumLedgerTypesGrouped depends only on the window — it belongs in the " +
      "Promise.all, not in series behind it",
  );
});

test("the promo-codes tab does not block its table behind the KPI strip", () => {
  const source = read(PROMO_TAB);

  // An async tab body awaits the strip aggregate BEFORE React ever reaches the
  // table's Suspense boundary, so the two heavy reads run in series. The body
  // must stay synchronous, with the strip streamed as its own child.
  assert.doesNotMatch(
    source,
    /export async function PromoCodesTab/,
    "PromoCodesTab must not be async — stream the strip in its own child",
  );
  assert.match(source, /<Suspense fallback={<StripSkeleton \/>}>/);

  // A safeQuery with no timeout only catches a THROW; a merely slow aggregate
  // would still hang the strip's boundary open indefinitely.
  assert.match(
    source,
    /"promoCodes\.stripStats",\s*\n\s*REWARD_QUERY_TIMEOUT_MS,/,
    "the strip aggregate needs a bounded wait, not just a try/catch",
  );
});

test("the /rewards shell renders every tab chip while the active tab streams", () => {
  const page = read("src/app/(admin)/rewards/page.tsx");
  const loading = read("src/app/(admin)/rewards/loading.tsx");

  // Only the selected tab may be rendered/awaited — a hidden tab that renders
  // would fire its own reads on first paint.
  assert.match(page, /<Suspense key={tab} fallback={<TabFallback tab={tab} \/>}>/);

  // The loading shell must show the same number of chips the page does, or the
  // tab bar visibly resizes when the real page swaps in.
  const tabCount = page.match(/\{ value: "[a-z-]+", label: "/g)?.length ?? 0;
  assert.ok(tabCount > 0, "expected to find the TABS list in page.tsx");
  assert.match(
    loading,
    new RegExp(`TabBarSkeleton count={${tabCount}}`.replace(/[{}]/g, "\\$&")),
    `loading.tsx must render ${tabCount} tab chips to match page.tsx`,
  );
});
