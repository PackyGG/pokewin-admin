import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Guardrails for the keep-warm cron's DEMAND on the shared MAIN mirror.
 *
 * Mirror reads are admitted by a process-wide semaphore sized to the mirror
 * pool (`withReadAdmissionControl`, `src/lib/db.ts`), and that budget is shared
 * with live admin page renders. Anything this cron reads is read INSTEAD of a
 * page's read, so the two invariants worth pinning are:
 *
 *   1. it warms exactly the caches a rendered surface reads — no more (dead
 *      warmers are pure theft from live loads) and no fewer (a cold shared
 *      cache is what makes the first page load degrade to an error tile), and
 *   2. its peak fan-out stays bounded and its wall clock stays inside the
 *      platform's `maxDuration`.
 *
 * Everything is read off the source with `readFileSync` — nothing here imports
 * a route module (they pull in `server-only` + the DB clients) and nothing
 * imports the antifraud service (root-only deps on Vercel).
 */

const WARM_ROUTE = "src/app/api/cron/warm/route.ts";

const read = (file: string): string => readFileSync(file, "utf8");

/**
 * Comment-free view of a module. Every "is this symbol actually read here?"
 * check below runs against this: these files carry long design notes that name
 * the very readers whose absence is being asserted, so matching raw text would
 * make each invariant pass on its own explanation.
 */
function codeOf(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // `(?<![:/])` keeps `https://…` inside a string literal from swallowing
    // the rest of its line.
    .replace(/(?<![:/])\/\/.*$/gm, " ");
}

/** `40_000` style literals -> number. */
function numericLiteral(source: string, pattern: RegExp): number {
  const captured = source.match(pattern)?.[1];
  if (!captured) throw new Error(`could not read ${pattern} from source`);
  return Number(captured.replaceAll("_", ""));
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry)) out.push(full.split(path.sep).join("/"));
    }
  };
  walk(root);
  return out;
}

const SOURCE_FILES = [
  ...listSourceFiles("src/app"),
  ...listSourceFiles("src/lib"),
];

/** Files that reference `symbol`, excluding the module that defines it. */
function referencingFiles(symbol: string, definedIn: string): string[] {
  const pattern = new RegExp(`\\b${symbol}\\b`);
  return SOURCE_FILES.filter(
    (file) => file !== definedIn && pattern.test(codeOf(file)),
  );
}

/**
 * Readers whose warmers were REMOVED because the surface they were written for
 * no longer exists, and which therefore cost a full fan-out every five minutes
 * for a cache key nobody read:
 *
 *   • `getDashboardStats` — /dashboard now reads
 *     `getScopedDashboardTrendSeries` (charts) and `buildKpiWindowPayload`
 *     (KPI strip); the cron was its only caller.
 *   • `getCostBreakdownLifetimeCached` / `getInsightsHubWager` — the /insights
 *     hub page and topbar money pills are gone. /analytics reads
 *     `getCostBreakdownCached`, a different `unstable_cache` key.
 *   • `getTotalUserCount` — fills `cachedUserCounts` under the exact key
 *     `dashboardStatsInner` computes, which the KPI-snapshot warmer already
 *     fills, and has no other caller.
 *
 * This is a CONDITIONAL invariant, not a ban: the moment a page reads one of
 * them again, its cache goes cold on every first load unless the cron warms it,
 * so this fails until the warmer comes back.
 */
const ORPHANED_READERS: ReadonlyArray<{ symbol: string; definedIn: string }> = [
  { symbol: "getDashboardStats", definedIn: "src/lib/queries/dashboard.ts" },
  {
    symbol: "getCostBreakdownLifetimeCached",
    definedIn: "src/lib/queries/insights-analytics/cost-breakdown.ts",
  },
  {
    symbol: "getInsightsHubWager",
    definedIn: "src/lib/queries/insights-analytics/hub-wager.ts",
  },
  { symbol: "getTotalUserCount", definedIn: "src/lib/queries/dashboard.ts" },
];

test("a reader with a live consumer again is warmed again", () => {
  const warm = codeOf(WARM_ROUTE);

  for (const { symbol, definedIn } of ORPHANED_READERS) {
    const consumers = referencingFiles(symbol, definedIn).filter(
      (file) => file !== WARM_ROUTE && !file.startsWith("src/app/api/"),
    );
    if (consumers.length === 0) {
      assert.ok(
        !new RegExp(`\\b${symbol}\\b`).test(warm),
        `${symbol} has no consumer outside its own module, so the warm cron ` +
          "must not pay its fan-out every five minutes",
      );
      continue;
    }
    assert.ok(
      new RegExp(`\\b${symbol}\\b`).test(warm),
      `${symbol} is read again by ${consumers.join(", ")} — the warm cron ` +
        "must warm its cache or those surfaces load cold",
    );
  }
});

test("the dashboard's own readers are the ones the cron warms", () => {
  const warm = codeOf(WARM_ROUTE);
  const dashboardPage = codeOf("src/app/(admin)/dashboard/page.tsx");

  // The two readers whose degraded paths are the reported error tiles:
  // `TileErrorFallback` ("Couldn't load this section") on the KPI strip and
  // "Live data is temporarily unavailable" on each trend chart. Warming a
  // DIFFERENT entry point than the page renders warms the wrong cache key.
  for (const reader of [
    "buildKpiWindowPayload",
    "getScopedDashboardTrendSeries",
  ]) {
    assert.ok(
      dashboardPage.includes(reader),
      `/dashboard is expected to read ${reader}`,
    );
    assert.ok(
      warm.includes(reader),
      `the warm cron must warm ${reader} — it is what /dashboard reads`,
    );
  }

  // `computeKpiWindowPayload` awaits `getDashboardKpiStats` as its first leg,
  // so warming that aggregate alongside the snapshot runs the same 11-query
  // batch twice for zero extra cache coverage.
  assert.ok(
    codeOf("src/app/(admin)/dashboard/kpi-window-data.ts").includes(
      "getDashboardKpiStats",
    ),
    "the KPI snapshot is expected to drive getDashboardKpiStats itself",
  );
  assert.ok(
    !/\bgetDashboardKpiStats\b/.test(warm),
    "getDashboardKpiStats is subsumed by buildKpiWindowPayload — warming both " +
      "duplicates the whole dashboard aggregate",
  );
});

test("warmers are declared once each and split into bounded lanes", () => {
  const warm = codeOf(WARM_ROUTE);

  const labels = [...warm.matchAll(/^\s*\["([A-Za-z0-9]+)",/gm)].map(
    (m) => m[1],
  );
  const laneLabels = [
    ...warm.matchAll(/^\s*"([A-Za-z0-9]+)",\s*$/gm),
  ].map((m) => m[1]);
  const all = [...labels, ...laneLabels];
  assert.ok(all.length > 0, "expected at least one declared warmer label");
  assert.equal(
    new Set(all).size,
    all.length,
    `duplicate warmer label in the cron: ${all.join(", ")}`,
  );

  // Peak demand is one heavy fan-out at a time. Each lane is drained by a
  // sequential `await` loop, and exactly two lanes run concurrently — so a
  // future edit that fans the heavy lane back out has to change this shape.
  assert.match(
    warm,
    /for \(const \[label, run\] of lane\) \{[\s\S]*?await run\(\)/,
    "each lane must await its warmers one at a time",
  );
  const laneRuns = warm.match(/runWarmLane\(/g)?.length ?? 0;
  assert.equal(
    laneRuns,
    3, // the declaration plus the two concurrent lanes
    "exactly two warm lanes may run concurrently",
  );
  assert.match(
    warm,
    /runWarmLane\(HEAVY_WARMERS/,
    "the heavy aggregates must be drained by a single serial lane",
  );
});

test("the cron stops starting warmers before the platform kills it", () => {
  const warm = read(WARM_ROUTE);

  const deadlineMs = numericLiteral(
    warm,
    /const WARM_START_DEADLINE_MS = ([\d_]+);/,
  );
  const maxDurationSeconds = numericLiteral(
    warm,
    /export const maxDuration = ([\d_]+);/,
  );

  // A run cut off by `maxDuration` mid-warmer leaves a frozen isolate holding
  // mirror sessions and read permits until the watchdog reclaims them. The
  // start gate must therefore close strictly before the platform kill — the
  // relationship is the invariant, not either number.
  assert.ok(
    deadlineMs < maxDurationSeconds * 1000,
    `WARM_START_DEADLINE_MS (${deadlineMs}ms) must close before ` +
      `maxDuration (${maxDurationSeconds}s)`,
  );
  assert.match(
    warm,
    /if \(Date\.now\(\) >= deadline\)/,
    "the lane must check the deadline before starting the next warmer",
  );
});

test("the mirror ping still load-sheds the whole warm pass", () => {
  const warm = read(WARM_ROUTE);

  // The cheap `SELECT 1` is the gate: if the mirror cannot serve one statement,
  // launching the aggregate warmers into the same constrained role only deepens
  // the outage the live pages are already in.
  const pingIndex = warm.indexOf("sql`SELECT 1`");
  const warmIndex = warm.indexOf("runWarmLane(HEAVY_WARMERS");
  assert.ok(pingIndex > 0 && warmIndex > pingIndex, "ping must precede warming");
  assert.match(
    warm,
    /postgres: "unavailable"[\s\S]*?status: 503/,
    "a mirror that cannot answer SELECT 1 must skip warming with a 503",
  );
});
