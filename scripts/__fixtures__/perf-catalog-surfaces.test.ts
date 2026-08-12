import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Read-budget guardrails for the catalog surfaces
 *  (/packs, /packs/[id], /cards, /sets, /upgrader)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Every MAIN read on these pages passes through the process-wide mirror
 * admission semaphore, so the thing that decides whether a page paints or
 * renders "Couldn't load this section" is the TOTAL NUMBER of reads a single
 * render issues — not how fast any one of them is. Once the queue is longer
 * than the permit count, the tail of the fan-out blows each leg's own
 * `safeQuery` budget and tiles fail at random.
 *
 * These tests pin the STRUCTURAL invariants that keep that count down. They
 * deliberately pin no tuning numbers (pool sizes, timeouts, revalidate
 * windows) — only "this read is not issued twice" and "this hidden component
 * does not read before it opens", which are the properties a future edit can
 * silently regress.
 *
 * Source is read with `readFileSync` rather than imported: these are Next.js
 * server modules ("server-only", next/cache, JSX), and a root fixture must
 * stay importable in the Vercel build environment.
 */

const read = (path: string) => readFileSync(path, "utf8");

/** Occurrences of `name(` that are not part of an import statement. */
function callSites(source: string, name: string): number {
  return source
    .split("\n")
    .filter((line) => !/^\s*(import|export)\s/.test(line))
    .filter((line) => !line.trimStart().startsWith("*"))
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .split(new RegExp(`\\b${name}\\s*\\(`)).length - 1;
}

/** Everything from a declaration marker to the end of the file. */
function bodyFrom(source: string, marker: string): string {
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `could not find ${marker}`);
  return source.slice(index);
}

/**
 * /packs resolved the SAME admin permission row twice per render for a
 * non-admin viewer: once for the Transactions-tab visibility gate and once
 * inside `resolveCatalogCaps`, serialized because the caps call was awaited
 * after the gate. One row, one read.
 */
test("packs page reads the viewer's permissions at most once per render", () => {
  const page = read("src/app/(admin)/packs/page.tsx");
  assert.equal(
    callSites(page, "getUserPermissions"),
    1,
    "getUserPermissions must be called once and its result shared between " +
      "the transactions-tab gate and the catalog capability flags",
  );
});

/**
 * The pack detail hero used to be seeded by a SECOND identity read of the same
 * `packs` row the detail fetch already returns, fired in parallel on every
 * open — and it was the only read on this surface issued against the primary
 * MAIN pool instead of the read mirror.
 */
test("pack detail does not issue a second identity read alongside the detail fetch", () => {
  const actions = read("src/app/(admin)/packs/actions.ts");
  const view = read("src/app/(admin)/packs/pack-detail-view.tsx");

  assert.ok(
    !/export async function fetchPackListSeed\b/.test(actions),
    "fetchPackListSeed duplicated getPackDetail's own columns — do not reintroduce it",
  );
  assert.equal(
    callSites(view, "fetchPackListSeed"),
    0,
    "the pack detail header must be derived from the single core-detail read",
  );
  assert.equal(
    callSites(view, "fetchPackDetailCore"),
    1,
    "the pack detail view should have exactly one core-detail fetch site",
  );
});

/**
 * The Add Cards dialog is closed on every catalog paint. Its set + rarity
 * dropdown options must therefore load when it OPENS, not with the segment
 * (CLAUDE.md: drawers, modals and collapsed sections run no query before they
 * open). Same rule the /cards bulk-move dialog already follows.
 */
test("upgrader Add Cards options load on open, not with the catalog segment", () => {
  const catalogTab = read("src/app/(admin)/upgrader/_components/catalog-tab.tsx");
  const dialog = read("src/app/(admin)/upgrader/add-cards-dialog.tsx");

  assert.equal(
    callSites(catalogTab, "getUpgraderPickerFilters"),
    0,
    "the catalog segment must not fetch the closed dialog's dropdown options",
  );
  assert.equal(
    callSites(dialog, "getUpgraderPickerFilters"),
    1,
    "the dialog owns exactly one deferred fetch of its dropdown options",
  );
  assert.ok(
    /if \(!open \|\| filtersRequestedRef\.current\) return;/.test(dialog),
    "the deferred fetch must be gated on the dialog actually being open, and " +
      "must not refire on every open",
  );
});

/**
 * Shell-first: the /sets page body must await nothing but the session, so the
 * PageHero flushes before any MAIN read starts and the reads then overlap
 * inside their own Suspense boundaries instead of running in front of them.
 */
test("sets page body awaits no data read before the shell", () => {
  const page = read("src/app/(admin)/sets/page.tsx");
  const pageBody = bodyFrom(page, "export default async function SetsPage(");

  for (const loader of ["safeQuery", "loadPrimary", "loadSecondary"]) {
    assert.equal(
      callSites(pageBody, loader),
      0,
      `${loader} in the /sets page body would block PageHero on a MAIN read`,
    );
  }
  assert.ok(
    /<Suspense[\s\S]*<SetsFilterSection \/>/.test(pageBody),
    "the series options must be fetched inside the filter bar's own boundary",
  );
});

/**
 * Every list/KPI/detail read on these surfaces stays individually isolated, so
 * one slow leg degrades its own tile rather than the page. This pins the
 * wrapper's presence, not its timeout value.
 */
test("catalog surface reads stay individually failure-isolated", () => {
  const files = [
    "src/app/(admin)/packs/_components/catalog-tab.tsx",
    "src/app/(admin)/packs/packs-kpi-strip.tsx",
    "src/app/(admin)/cards/page.tsx",
    "src/app/(admin)/sets/page.tsx",
    "src/app/(admin)/upgrader/_components/catalog-tab.tsx",
  ];
  for (const file of files) {
    const source = read(file);
    assert.ok(
      /\b(safeQuery|loadPrimary|loadSecondary)\s*\(/.test(source),
      `${file} must route its reads through safeQuery/loadPrimary so a single ` +
        "failure degrades one tile instead of the whole page",
    );
  }
});
