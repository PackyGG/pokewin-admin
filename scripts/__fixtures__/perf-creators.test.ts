import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Read-count guardrails for the /creators area.
 *
 * Every MAIN read on this surface passes through a process-wide admission
 * semaphore sized to the mirror pool (`withReadAdmissionControl`, src/lib/db.ts),
 * and each leg is bounded by its own `safeQuery` timeout. So the failure mode
 * that produces "Couldn't load this section" is not a single slow query — it is
 * TOTAL reads per render: once enough legs queue behind the cap, the tail of the
 * queue blows its own budget and tiles blank one at a time, differently on every
 * reload.
 *
 * These tests therefore pin STRUCTURE (how many independent walks/reads a render
 * can issue, and where they are sourced from), never tuning values. Pool sizes,
 * TTLs and timeout budgets are deliberately not asserted — they are measured
 * numbers that should be free to move.
 *
 * Source is read with `readFileSync` rather than imported: these modules are
 * `server-only` and reach the pg pool transitively, and a root fixture must
 * never pull runtime dependencies that only exist outside the Vercel root
 * install.
 */
const read = (path: string) => readFileSync(path, "utf8");

/**
 * Source with comments stripped.
 *
 * Every assertion below is about what the module DOES, so it has to look at
 * code only. The modules carry deliberately detailed comments naming the call
 * sites that were removed ("this used to page creatorsApi.list...") — matching
 * raw text would fail on the very prose that documents the fix, and would push
 * the next author to delete the explanation to get the gate green.
 *
 * Full-line `//` comments and block comments are removed; trailing `//` is left
 * alone so `https://` inside a string is never mangled.
 */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const CREATORS = "src/app/(admin)/creators";

test("the Converted tile's stats read does not walk the backend creator roster", () => {
  const stats = code(`${CREATORS}/_queries/creators-stats.ts`);

  // `getCreatorsGlobalStats` used to await a full paginated `creatorsApi.list`
  // walk whose four count outputs (totalCreators / fillCreatorCount /
  // activeDealCount / liveCount) had no consumer anywhere in the repo. Because
  // it was a SERIAL PREFIX that throws on a backend outage, it made a tile
  // built entirely from MAIN-DB voucher aggregates render "—" whenever the
  // backend was slow or down.
  assert.ok(
    !/creatorsApi/.test(stats),
    "creators-stats.ts must not read the backend creator roster — every figure " +
      "it returns comes from MAIN-DB voucher aggregates, and a backend " +
      "dependency here reintroduces the false 'backend unavailable' Converted tile",
  );

  // Guard the regression directly: if a count field comes back, so does the walk.
  for (const dead of [
    "totalCreators",
    "fillCreatorCount",
    "activeDealCount",
    "liveCount",
  ]) {
    assert.ok(
      !stats.includes(dead),
      `creators-stats.ts must not compute '${dead}' — it has no consumer; ` +
        "re-adding it re-adds the discarded roster walk",
    );
  }
});

test("creator-count queries share the one cached roster walk", () => {
  // A single /creators render resolves the fill count, the multiplier count and
  // the tab list. All three answer questions about the SAME roster. Each used to
  // page `creatorsApi.list` privately, so one screen walked the roster three
  // times over and over again in parallel with the shared cache doing it a
  // fourth time. The shared walk is also the only resilient one — it retains a
  // last-known-good roster and falls back to a read-only PostgreSQL query — so
  // the private copies were also the ones that blanked their tiles on a blip.
  for (const file of [
    `${CREATORS}/_queries/fill-creator-count.ts`,
    `${CREATORS}/_queries/multiplier-creator-count.ts`,
    `${CREATORS}/_queries/list-creators-by-tab.ts`,
  ]) {
    const source = code(file);
    assert.ok(
      source.includes("getCachedCreatorRoster"),
      `${file} must resolve the creator roster through getCachedCreatorRoster()`,
    );
    assert.ok(
      !/creatorsApi\s*\.\s*list/.test(source),
      `${file} must not page creatorsApi.list itself — that is a duplicate ` +
        "roster walk with no stale-retention and no PostgreSQL fallback",
    );
  }
});

test("the creator detail page fetches only the momentum figures it renders", () => {
  const page = code(`${CREATORS}/[userId]/page.tsx`);

  // The detail KPI strip renders exactly two momentum numbers. It used to get
  // them from `getCodeAndWagerByUser`, which issues six round-trips (five MAIN
  // + one ADMIN) and whose wager leg is an unbounded lifetime scan, then threw
  // four of the six results away.
  assert.ok(
    !/getCodeAndWagerByUser\s*\(/.test(page),
    "the creator detail page must not call getCodeAndWagerByUser — it fires " +
      "six reads for the two momentum fields this page actually renders",
  );
  assert.ok(
    /getMomentum3dByUser\s*\(/.test(page),
    "the momentum tile must read through getMomentum3dByUser (one bounded read)",
  );
});

test("the momentum read is a single date-bounded statement", () => {
  const momentum = code(`${CREATORS}/_queries/momentum-3d-by-user.ts`);

  const reads = momentum.match(/queryRows</g)?.length ?? 0;
  assert.equal(
    reads,
    1,
    "getMomentum3dByUser must stay a single round-trip — its whole reason for " +
      "existing is that the general-purpose helper cost six",
  );

  // The point of the split was dropping the lifetime `total_wagered` sum, which
  // scanned every acu wager row a creator ever had. An unbounded variant here
  // would put that scan straight back on the detail page's critical path.
  assert.ok(
    /created_at\s*>=\s*NOW\(\)\s*-\s*INTERVAL/.test(momentum),
    "the momentum scan must carry a date lower bound",
  );
});

test("/creators issues no uncached catalog probe on the request path", () => {
  const netPnl = code(`${CREATORS}/_queries/all-creators-net-pnl.ts`);

  // `to_regclass` looks free, but mirror clients use maxUses:1 — every read is a
  // fresh connection holding one of the global admission permits. Uncached, it
  // was a guaranteed MAIN round-trip on every render even when all three heavy
  // scans it gates were warm cache hits.
  const probeIndex = netPnl.indexOf("to_regclass");
  assert.notEqual(probeIndex, -1, "expected the upgrader_games probe to exist");

  const cacheIndex = netPnl.indexOf("cachedHasUpgraderTable");
  assert.notEqual(
    cacheIndex,
    -1,
    "the upgrader_games probe must be wrapped in a cross-request cache",
  );
  assert.ok(
    cacheIndex < probeIndex,
    "the to_regclass probe must live inside the cached helper, not on the " +
      "request path ahead of it",
  );
});

test("every /creators route keeps its shell-first loading fallback", () => {
  // Shell-first streaming is what keeps a slow leg from blanking the page
  // rather than one tile: the hero and static controls must paint before any
  // heavy read resolves, and the route needs a matching loading.tsx.
  for (const route of [
    "",
    "/analytics",
    "/changelog",
    "/leaderboards",
    "/settings",
    "/socials",
  ]) {
    const page = code(`${CREATORS}${route}/page.tsx`);
    assert.ok(
      page.includes("<Suspense"),
      `${CREATORS}${route}/page.tsx must stream its data behind <Suspense>`,
    );
    assert.doesNotThrow(
      () => read(`${CREATORS}${route}/loading.tsx`),
      `${CREATORS}${route} must ship a loading.tsx rendering the same shell`,
    );
  }
});
