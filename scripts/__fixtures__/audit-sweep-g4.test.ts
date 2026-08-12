import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const AUTO_BANS_DIR = "src/app/(antifraud)/antifraud/auto-bans";

test("Auto Bans paints its shell before the admin reads resolve", () => {
  const page = read(`${AUTO_BANS_DIR}/page.tsx`);

  // The page body may await ONLY the access gate and the searchParams. A bare
  // `await listWhopAutoBans(...)` there blocks the hero, the KPI strip and the
  // search box behind three admin queries.
  assert.doesNotMatch(page, /await listWhopAutoBans\(/);
  assert.match(page, /safeQueryOrNull\(\s*\(\) => listWhopAutoBans\(/);
  assert.match(page, /<Suspense[\s\S]*?fallback={<AutoBansKpiSkeleton \/>}/);
  assert.match(page, /<Suspense[\s\S]*?fallback={<AutoBansListSkeleton \/>}/);

  // Both boundaries await the SAME in-flight promise, so splitting them (to
  // keep the static search panel between the strip and the list) still costs
  // exactly one round of queries.
  assert.match(page, /<AutoBansKpis read={read} \/>/);
  assert.match(page, /<AutoBansList read={read}/);

  // A failed/timed-out read degrades to a panel instead of `error.tsx`.
  assert.match(page, /Automatic bans could not be loaded/);
});

test("Auto Bans has a route-level fallback sharing the page's skeletons", () => {
  assert.ok(
    existsSync(`${AUTO_BANS_DIR}/loading.tsx`),
    "auto-bans must ship a loading.tsx like every sibling antifraud route",
  );
  const loading = read(`${AUTO_BANS_DIR}/loading.tsx`);
  assert.match(loading, /from "\.\/auto-bans-skeleton"/);
  assert.match(loading, /<AutoBansKpiSkeleton \/>/);
  assert.match(loading, /<AutoBansSearchSkeleton \/>/);
  assert.match(loading, /<AutoBansListSkeleton \/>/);
});

test("the overview action feed deduplicates payments before the intent LATERAL", () => {
  const overview = read("src/lib/antifraud/overview.ts");
  const feedStart = overview.indexOf("db.execute<MainFeedRow>");
  assert.ok(feedStart > 0, "feed statement not found");
  const feed = overview.slice(feedStart, overview.indexOf("]);", feedStart));

  const distinctOn = feed.indexOf("SELECT DISTINCT ON");
  const lateral = feed.indexOf("LEFT JOIN LATERAL");
  assert.ok(distinctOn > 0 && lateral > 0);
  // Postgres applies DISTINCT ON *after* the joins, so a LATERAL sharing the
  // SELECT runs once per raw webhook event instead of once per payment.
  assert.ok(
    distinctOn < lateral,
    "the DISTINCT ON winner CTE must come before the intent LATERAL",
  );
  assert.match(feed, /WITH provider_paid AS \(/);
  assert.match(feed, /FROM provider_paid paid/);
});

test("the overview reads only the column the unresolved-review scope needs", () => {
  const overview = read("src/lib/antifraud/overview.ts");
  // The `signals` text[] was selected for every live review and never read.
  assert.doesNotMatch(
    overview,
    /signals: antifraud_reviews\.signals/,
  );
});

test("the dashboard GGR-breakdown leg carries its own leg budget", () => {
  const kpi = read("src/app/(admin)/dashboard/kpi-window-data.ts");
  // Without a timeout this leg can outlive KPI_PAYLOAD_TIMEOUT_MS, and when
  // the outer backstop wins `partial` was never assigned — so one slow
  // breakdown blanks the whole KPI strip.
  assert.match(
    kpi,
    /safeQuery\(\s*\(\) => getGgrBreakdownForKpiWindow\(window\),[\s\S]*?KPI_LEG_TIMEOUT_MS,/,
  );
  assert.doesNotMatch(kpi, /getGgrBreakdownForKpiWindow\(window\)\.catch\(/);
});

test("SQL comments in the files this sweep touched carry no backticks", () => {
  // A backtick inside a sql`…` template literal terminates the literal and
  // turns the file into a syntax error. Two files in this repo were broken
  // that way while this sweep ran.
  for (const path of [
    "src/lib/antifraud/overview.ts",
    "src/app/(admin)/dashboard/kpi-window-data.ts",
  ]) {
    for (const line of read(path).split("\n")) {
      if (/^\s*--/.test(line)) {
        assert.ok(!line.includes("`"), `backtick in SQL comment: ${path}`);
      }
    }
  }
});
