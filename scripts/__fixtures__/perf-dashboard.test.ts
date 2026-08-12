import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Source is READ, never imported: this fixture runs from the repo root where
// only root dependencies exist, and a runtime import of a service workspace
// breaks the Vercel build.
const read = (relativePath: string) =>
  readFileSync(path.join(process.cwd(), relativePath), "utf8");

const dashboard = read("src/lib/queries/dashboard.ts");
const fiat = read("src/lib/queries/dashboard-fiat.ts");
const page = read("src/app/(admin)/dashboard/page.tsx");
const payload = read("src/app/(admin)/dashboard/kpi-window-data.ts");
const redis = read("src/lib/cache/redis.ts");

test("the today/24h KPI path does not run the discarded snapshot aggregates", () => {
  // `computeKpiWindowPayload` reads five fields off this aggregate. Running the
  // window-independent snapshot legs (user counts, lifetime balance sums,
  // depositors, 24h pack/battle counts, FTDs, inventory/voucher delta, lifetime
  // deposit counts) produced eight mirror reads whose results were thrown away
  // — and at the batch's concurrency limit they queued AHEAD of the headline
  // GGR/wager leg, pushing it past its own budget so the Wager box rendered
  // "Live wager data is retrying automatically" and the GGR section vanished.
  assert.match(dashboard, /includeSnapshotMetrics\?: boolean;/);
  assert.match(dashboard, /includeSnapshotMetrics: false,/);
  assert.match(
    dashboard,
    /const includeSnapshots = config\.includeSnapshotMetrics \?\? true;/,
  );

  for (const leg of [
    "cachedUserCounts",
    "cachedBalanceAggregates",
    "cachedUniqueDepositors",
    "cached24hPackOpens",
    "cached24hBattles",
    "cachedFtdCombined",
    "cachedLifetimeDepositMetrics",
  ]) {
    assert.match(
      dashboard,
      new RegExp(`includeSnapshots\\s*\\?\\s*${leg}\\(`),
      `${leg} must be gated on includeSnapshots inside the stats batch`,
    );
  }
  // The windowed inventory/voucher delta is an inline statement, not a helper.
  assert.match(
    dashboard,
    /dashboard\.windowedPeriodDelta[\s\S]{0,120}!includeSnapshots/,
  );
});

test("the narrowed KPI return cannot expose a field the skipped legs fed", () => {
  const start = dashboard.indexOf("export const getDashboardKpiStats = cache(");
  assert.ok(start > 0, "getDashboardKpiStats not found");
  const body = dashboard.slice(start, dashboard.indexOf("\n);", start));
  // Only the five consumed fields (plus the two compute-metadata primitives)
  // may leave this path; anything else would be a zeroed snapshot field.
  for (const field of [
    "users:",
    "financials:",
    "activity:",
    "realizedPnlPeriod,",
  ]) {
    assert.ok(
      !body.includes(field),
      `getDashboardKpiStats must not return ${field} on the lean path`,
    );
  }
  for (const field of [
    "ggr:",
    "wagers:",
    "wagersBreakdown:",
    "wagersOrganic:",
  ]) {
    assert.ok(
      body.includes(field),
      `getDashboardKpiStats must still return ${field}`,
    );
  }
  // The chip-enum path keeps the FULL payload — the lean flag is opt-in.
  const chipStart = dashboard.indexOf(
    "export const getDashboardStats = cache(",
  );
  const chipBody = dashboard.slice(
    chipStart,
    dashboard.indexOf("\n});", chipStart),
  );
  assert.ok(!chipBody.includes("includeSnapshotMetrics"));
});

test("the KPI GGR breakdown reuses a cache instead of re-running the gaming legs", () => {
  // `ggrBreakdownForWindow` calls `getGamingLegs` — five mirror reads — and the
  // headline beside it reaches the same legs through `cachedKpiWindowMetrics`.
  // Uncached, both legs of one payload build ran that fan-out concurrently.
  assert.match(dashboard, /const cachedKpiGgrBreakdown = unstable_cache\(/);
  const start = dashboard.indexOf(
    "export async function getGgrBreakdownForKpiWindow",
  );
  const body = dashboard.slice(start, dashboard.indexOf("\n}", start));
  assert.match(body, /cachedKpiGgrBreakdown\(/);
  assert.match(
    body,
    /if \(\(await readDbEnv\(\)\) !== "prod"\)[\s\S]{0,100}ggrBreakdownForWindow/,
    "only a dev-toggled request may bypass the shared production cache",
  );

  // The breakdown and the headline it must reconcile with share a revalidation
  // tag, so they roll over together. Pin the shared tag, not the TTL value.
  for (const name of ["cachedKpiWindowMetrics", "cachedKpiGgrBreakdown"]) {
    const at = dashboard.indexOf(`const ${name} = unstable_cache(`);
    assert.ok(at > 0, `${name} not found`);
    const decl = dashboard.slice(at, dashboard.indexOf("\n);", at));
    assert.match(decl, /tags: \["dashboard-activity"\]/);
  }
});

test("dashboard metric caches preserve DB environment isolation", () => {
  // Cookie lookup inside unstable_cache can fall back to prod because the
  // callback is detached from the request. Dev-toggled reads must bypass it.
  assert.match(
    dashboard,
    /if \(env !== "prod"\) \{[\s\S]{0,140}windowMetricsForPeriodInner/,
  );
  assert.match(dashboard, /env === "prod"[\s\S]{0,120}cachedKpiWindowMetrics/);
  assert.match(
    dashboard,
    /await readDbEnv\(\)[\s\S]{0,100}!== "prod"[\s\S]{0,100}ggrBreakdownForWindow/,
  );
});

test("rolling KPI caches use a reusable minute-bucket cutoff", () => {
  const period = read("src/lib/queries/dashboard-period.ts");
  assert.match(period, /export function kpiWindowToCacheCutoff\(/);
  assert.match(period, /Math\.floor\(now\.getTime\(\) \/ 60_000\) \* 60_000/);
  assert.match(
    dashboard,
    /const cutoff = kpiWindowToCacheCutoff\(window, now\);/,
  );
  for (const file of [
    "src/lib/queries/dashboard-cashflow-pg.ts",
    "src/lib/queries/dashboard-fiat.ts",
    "src/lib/queries/dashboard-deposit-funded-ggr.ts",
  ]) {
    assert.match(read(file), /kpiWindowToCacheCutoff\(window, now\)/, file);
  }
});

test("every dashboard Redis operation has a fail-open deadline", () => {
  assert.match(redis, /const REDIS_OPERATION_TIMEOUT_MS = /);
  for (const operation of ["get", "set", "eval", "del"]) {
    assert.match(
      redis,
      new RegExp(
        `withRedisDeadline\\(["'][A-Z_]+["'],\\s*\\(\\) =>\\s*r\\.${operation}(?:<[^>]+>)?\\(`,
      ),
      `Redis ${operation.toUpperCase()} must be deadline bounded`,
    );
  }
  assert.doesNotMatch(redis, /await r\.(?:get|set|eval|del)\(/);
});

test("Redis misses are coalesced and outages are circuit-broken", () => {
  assert.match(redis, /singleFlight\(`redis:get-or-set:\$\{key\}`/);
  assert.match(redis, /staleWhileRevalidate\(/);
  assert.match(redis, /const REDIS_BREAKER_FAILURE_THRESHOLD = 2/);
  assert.match(redis, /redisCircuit\.openUntilMs > now/);
  assert.match(redis, /export function redisCacheSnapshot/);
});

test("Redis rate limiting is atomic and takes one REST round trip", () => {
  assert.match(redis, /r\.eval<\[string\], \[number, number\]>/);
  assert.match(redis, /redis\.call\('INCR'/);
  assert.match(redis, /redis\.call\('EXPIRE'/);
  assert.match(redis, /redis\.call\('TTL'/);
  assert.doesNotMatch(redis, /r\.incr\(|r\.expire\(|r\.ttl\(/);
});

test("the fiat metrics memo keys on a resolved cutoff, never on a Date argument", () => {
  // React cache() keys on argument identity. Memoizing on `now: Date` meant the
  // Fiat tile's one-arg call and the cash-flow leg's two-arg call landed in
  // different entries, so the heavy Whop webhook CTE ran twice per render.
  assert.ok(
    !fiat.includes("cache(loadDashboardFiatMetrics)"),
    "the fiat memo must not be keyed on the raw Date argument again",
  );
  assert.match(fiat, /const loadDashboardFiatMetricsForCutoff = cache\(/);
  assert.match(
    fiat,
    /loadDashboardFiatMetricsForCutoff\(\s*window,\s*kpiWindowToCacheCutoff\(window, now\)\.toISOString\(\),/,
  );
});

test("each KPI leg must be able to fail inside the payload budget", () => {
  // When the outer backstop wins, `partial` was never assigned and every box in
  // the strip degrades at once. Pin the RELATION between the budgets, not the
  // milliseconds — tuning either number stays free.
  const leg = /const KPI_LEG_TIMEOUT_MS = ([\d_]+);/.exec(payload);
  const outer = /const KPI_PAYLOAD_TIMEOUT_MS = ([\d_]+);/.exec(payload);
  assert.ok(leg && outer, "KPI timeout budgets not found");
  const legMs = Number(leg[1].replace(/_/g, ""));
  const outerMs = Number(outer[1].replace(/_/g, ""));
  assert.ok(
    legMs < outerMs,
    `per-leg budget (${legMs}ms) must stay under the payload budget (${outerMs}ms)`,
  );
});

test("the dashboard paints its shell before any data read", () => {
  assert.ok(existsSync("src/app/(admin)/dashboard/loading.tsx"));
  const start = page.indexOf("export default async function DashboardPage()");
  assert.ok(start > 0);
  const body = page.slice(start, page.indexOf("\n}", start));
  const awaits = body.match(/await [A-Za-z_][\w.]*\(/g) ?? [];
  assert.deepEqual(
    awaits,
    ["await requirePageAccess("],
    "the page body may await only the access gate — data belongs in a Suspense child",
  );
  assert.ok(body.indexOf("<PageHero>") > 0);
  // Every data-bearing child streams behind its own boundary.
  for (const child of [
    "DashboardTodayPnl",
    "DashboardRewardAndCreatorCostsToday",
    "DashboardUpgraderDoubleDownToday",
    "DashboardFiatToday",
    "DashboardKpiBoxes",
    "DashboardCharts",
  ]) {
    assert.match(
      body,
      new RegExp(`<Suspense[\\s\\S]{0,400}?<${child}\\s*/>`),
      `${child} must render inside a Suspense boundary`,
    );
  }
});
