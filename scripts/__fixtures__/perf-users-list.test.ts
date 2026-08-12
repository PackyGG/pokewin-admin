import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Read budget guardrails for the /users LIST page.
 *
 * Every MAIN read on this page passes through a process-wide admission
 * semaphore sized to the mirror pool (src/lib/db.ts). Concurrency is capped
 * globally, so the number of STATEMENTS one render issues — not the speed of
 * any single one — is what decides whether the tail of the queue blows each
 * leg's own safeQuery budget and paints "Couldn't load this section".
 *
 * These assertions pin the SHAPE that keeps the budget low. They deliberately
 * pin no tuning numbers (pool sizes, TTLs, timeout values) — only the
 * structural invariants that a future edit could silently undo.
 */

const ROOT = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

/**
 * Body of a top-level `function`/`async function` declaration, brace-matched.
 *
 * The opening brace is found by walking past the parameter list and then past
 * the return-type annotation — a naive `indexOf("{")` would stop inside
 * `Promise<{ … }>` and return the type instead of the body.
 */
function functionBody(src: string, name: string): string {
  const start = src.search(
    new RegExp(String.raw`(?:async\s+)?function\s+${name}\s*\(`),
  );
  assert.notEqual(start, -1, `expected a function named ${name}`);

  // Walk the parameter list to its matching close paren.
  let i = src.indexOf("(", start);
  let parens = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === "(") parens += 1;
    else if (src[i] === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  assert.ok(parens === 0, `unbalanced parameter list on ${name}`);

  // Then past the return type: braces inside `<…>` belong to the annotation.
  let angle = 0;
  let open = -1;
  for (i += 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "<") angle += 1;
    else if (ch === ">") angle -= 1;
    else if (ch === "{" && angle === 0) {
      open = i;
      break;
    }
  }
  assert.notEqual(open, -1, `expected a body for ${name}`);

  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  assert.fail(`unbalanced braces while reading ${name}`);
}

test("the page slice and its total come back on ONE statement", async () => {
  const src = await source("src/lib/queries/users-list.ts");

  // Both id resolvers used to fire the ordered slice and a standalone
  // `SELECT COUNT(*)` through Promise.all — two permits for one answer. The
  // total must now ride along on the slice statement.
  for (const fn of ["fetchColumnSortUserIds", "computeRankedUserIds"]) {
    const body = functionBody(src, fn);
    assert.match(
      body,
      /total_count/,
      `${fn} must carry the row total on the slice statement`,
    );
    // The standalone COUNT survives only as the empty-slice fallback, which
    // is reachable exclusively when the slice returned no row to carry the
    // window total. Anything else means the second statement is back on the
    // hot path.
    assert.match(
      body,
      /if \(orderedRows\.length > 0\) \{/,
      `${fn} must return the slice total without a second statement`,
    );
  }
});

test("the page rows and their display enrichments are ONE statement", async () => {
  const src = await source("src/lib/queries/users-list.ts");

  // The base row fetch plus the fingerprint / signup-provider /
  // shared-signup-IP lookups are all keyed on the SAME resolved id slice, so
  // they belong on one statement rather than four checkouts.
  const merged = functionBody(src, "fetchUserListPageRows");
  for (const cte of [
    /FROM "user" u/,
    /FROM fingerprints/,
    /FROM account a/,
    /FROM "user"\s+WHERE signup_ip IN/,
  ]) {
    assert.match(
      merged,
      cte,
      "every per-page enrichment must be a CTE on the merged statement",
    );
  }

  // A single `queryMainRows` call is the whole point — more than one would
  // mean the merge came apart again.
  assert.equal(
    (merged.match(/queryMainRows/g) ?? []).length,
    1,
    "fetchUserListPageRows must issue exactly one statement",
  );
});

test("hydration issues no reads of its own", async () => {
  const src = await source("src/lib/queries/users-list.ts");

  // Structural proof rather than a call count: a synchronous function cannot
  // await a query. If someone re-adds a per-page lookup here they have to
  // make it async again, and this fails.
  assert.match(
    src,
    /\nfunction hydrateUserListPage\(/,
    "hydrateUserListPage must stay synchronous — pure mapping, no reads",
  );
  const body = functionBody(src, "hydrateUserListPage");
  assert.doesNotMatch(body, /queryMainRows|await /);
});

test("/users renders its shell before any gate or MAIN read", async () => {
  const page = await source("src/app/(admin)/users/page.tsx");
  const body = functionBody(page, "UsersPage");

  // The Admin DB gate read was awaited in the page body, so the hero could
  // not paint until it answered. It belongs inside the Suspense legs that
  // actually consume it.
  assert.doesNotMatch(
    body,
    /await\s+getUsersPageGates/,
    "the gate read must not block the page shell",
  );
  assert.doesNotMatch(
    body,
    /await\s+getUsers\b|await\s+getUsersListStats/,
    "no MAIN read may be awaited in the page body",
  );

  // Both consumers own their own leg behind a Suspense boundary.
  assert.match(page, /<Suspense[\s\S]*?<UsersToolbarSection/);
  assert.match(page, /<Suspense[\s\S]*?<UsersTableSection/);
  for (const leg of ["UsersToolbarSection", "UsersTableSection"]) {
    assert.match(
      functionBody(page, leg),
      /getUsersPageGates\(/,
      `${leg} must resolve its own gates`,
    );
  }
});

test("the split gate read stays deduped and bounded", async () => {
  const gates = await source("src/app/(admin)/users/_lib/admin-gates.ts");

  // Two Suspense legs now ask for the same flags. Without the request-scoped
  // dedupe that is two Admin DB round trips instead of one, and without a
  // wall clock a hung Admin DB pins both legs with no failure state.
  assert.match(gates, /from "react"/);
  assert.match(gates, /cache\(\s*async/);
  assert.match(gates, /withTimeout\(/);
  assert.match(gates, /includeExcludedInSearch: false/);
});

test("the users list page keeps its shell-first loading mirror", async () => {
  const loading = await source("src/app/(admin)/users/loading.tsx");
  for (const piece of [
    /PageHeroSkeleton/,
    /KpiStripSkeleton/,
    /ToolbarSkeleton/,
    /SkeletonTable/,
    /PaginationSkeleton/,
  ]) {
    assert.match(loading, piece);
  }
});
