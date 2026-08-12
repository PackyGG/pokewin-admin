import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Guardrails for the g2 audit sweep. Each assertion pins a specific failure
 * mode that was measured or read out of the code, not a style preference.
 */

const reviewsPath = "src/lib/antifraud/reviews.ts";
const identitiesPath = "src/lib/antifraud/admin-identities.ts";
const autoRefreshPath = "src/app/(admin)/dashboard/auto-refresh.tsx";
const kycPath = "src/lib/backend-api/kyc.ts";

test("review reads never ship the columns nothing renders", async () => {
  const reviews = await readFile(reviewsPath, "utf8");

  // A bare `select()` pulled `antifraud_reviews.metadata` (jsonb, mapped by
  // nothing) for every queue row, and every containment bookkeeping column of
  // `antifraud_signals` for the case trail.
  assert.doesNotMatch(reviews, /\.select\(\)\.from\(antifraud_reviews\)/);
  assert.doesNotMatch(reviews, /\.select\(\)\.from\(antifraud_signals\)/);
  assert.doesNotMatch(reviews, /metadata: antifraud_reviews\.metadata/);

  // The one value the trail needs out of `payload` is extracted in SQL, so the
  // blob itself never crosses the wire.
  assert.match(reviews, /antifraud_signals\.payload\} -> 'scoreDelta'/);
  assert.doesNotMatch(reviews, /signalScoreDelta\(s\.payload\)/);
});

test("tab counts filter status in the outer WHERE without changing the counts", async () => {
  const reviews = await readFile(reviewsPath, "utf8");
  const query = reviews.slice(
    reviews.indexOf("getAccountReviewTabCounts"),
    reviews.indexOf("const row = result.rows[0]", reviews.indexOf("getAccountReviewTabCounts")),
  );

  // The hoist is only semantics-preserving because all three FILTER arms
  // already carried the same status predicate. If an arm ever stops requiring
  // it, the outer WHERE would silently drop rows the arm wants counted.
  const statusPredicates = query.match(
    /WHERE review\.status IN \('open', 'in_review', 'escalated'\)/g,
  );
  assert.equal(statusPredicates?.length, 4, "three FILTER arms plus the outer WHERE");
  assert.match(
    query,
    /WHERE review\.status IN \('open', 'in_review', 'escalated'\)\s*\n\s*AND review\.severity IN \('high', 'critical'\)/,
  );
});

test("dead review aggregates stay deleted", async () => {
  const reviews = await readFile(reviewsPath, "utf8");
  // These four exports had no consumers and carried unbounded full-table
  // aggregates — `getReviewStats` ran three correlated subqueries per row with
  // no date bound. Wiring one to a page would reproduce the tab-count problem.
  for (const gone of [
    "getReviewStats",
    "getReviewQueueStats",
    "listReviews",
    "listRecentSignals",
  ]) {
    assert.doesNotMatch(reviews, new RegExp(`\\b${gone}\\b`));
  }
});

test("admin identities resolve once per request, not once per call site", async () => {
  const identities = await readFile(identitiesPath, "utf8");
  assert.match(identities, /import \{ cache \} from "react"/);
  assert.match(identities, /cache\(\s*\(\): Map<string, AdminIdentity \| null>/);
  // Only the ids not already resolved this request may reach the DB.
  assert.match(identities, /const missing = unique\.filter\(\(id\) => !memo\.has\(id\)\)/);
  assert.match(identities, /inArray\(admin_users\.id, missing\)/);
});

test("auto refresh does not stack overlapping renders", async () => {
  const autoRefresh = await readFile(autoRefreshPath, "utf8");
  assert.match(autoRefresh, /useTransition/);
  assert.match(autoRefresh, /startTransition\(\(\) => \{\s*\n\s*router\.refresh\(\);/);
  // A tick that lands while the previous refresh is still resolving is skipped
  // rather than queued behind it on the two-connection MAIN mirror pool.
  assert.match(autoRefresh, /if \(startedAt !== null && Date\.now\(\) - startedAt < MAX_INFLIGHT_MS\) return;/);
  // …but never forever: a transition that never settles must not silence the
  // page permanently.
  assert.match(autoRefresh, /const MAX_INFLIGHT_MS = /);
  assert.match(autoRefresh, /if \(!isPending\) startedAtRef\.current = null;/);
});

test("KYC backend responses are parsed, not cast", async () => {
  const kyc = await readFile(kycPath, "utf8");
  // `backendApi` returns `{}` for any 2xx with a non-JSON body, so a bare cast
  // reported a no-op as a completed KYC decision.
  assert.doesNotMatch(kyc, /type Success<T> = \{ success: boolean/);
  const literalTrue = kyc.match(/success: z\.literal\(true\),/g);
  assert.equal(literalTrue?.length, 3, "status, require and review all assert it");
  for (const call of ["KYC status", "KYC requirement", "KYC review"]) {
    assert.match(kyc, new RegExp(`"${call}"`));
  }
  assert.match(
    kyc,
    /throw new Error\(`Backend returned an invalid \$\{what\} response`\)/,
  );
});
