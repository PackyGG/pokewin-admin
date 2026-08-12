import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  withTimeout,
  isQueryTimeoutError,
} from "../../src/lib/errors/safe-query";

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const TREND_SOURCE = "src/lib/queries/dashboard-trend-series.ts";

/**
 * Regression: the dashboard trend grid used to blank ALL SIX charts — the
 * Wager-attribution tile included — whenever the aggregate computation ran
 * long. Two defects combined:
 *
 *   1. the outer `withTimeout` was 10s while each leg's own `safeQuery` cap
 *      (`REWARD_QUERY_TIMEOUT_MS`) was 15s, so the outer race always fired
 *      first and the per-leg degradation this module is built around could
 *      never run;
 *   2. the partial snapshot was assigned as `partial = await withTimeout(...)`,
 *      so a rejection skipped the assignment entirely and the catch fell
 *      through to the all-false `emptyDashboardTrendSeries`.
 *
 * The result was "Live data is temporarily unavailable. The next automatic
 * refresh retries this chart." on every tile while five of six legs had in
 * fact succeeded.
 */

test("the aggregate trend timeout stays above the per-leg query timeout", () => {
  const trendSource = read(TREND_SOURCE);
  const safeQuerySource = read("src/lib/errors/safe-query.ts");

  const outerMatch = trendSource.match(
    /const TREND_SNAPSHOT_TIMEOUT_MS = ([\d_]+);/,
  );
  assert.ok(outerMatch, "TREND_SNAPSHOT_TIMEOUT_MS must be declared");
  const outerMs = Number(outerMatch[1].replaceAll("_", ""));

  const legMatch = safeQuerySource.match(
    /export const REWARD_QUERY_TIMEOUT_MS = ([\d_]+);/,
  );
  assert.ok(legMatch, "REWARD_QUERY_TIMEOUT_MS must be declared");
  const legMs = Number(legMatch[1].replaceAll("_", ""));

  assert.ok(
    outerMs > legMs,
    `aggregate trend timeout (${outerMs}ms) must exceed the per-leg timeout ` +
      `(${legMs}ms), otherwise per-leg degradation is unreachable and one ` +
      `slow leg blanks every chart`,
  );

  // The outer bound must also still be used at the call site.
  assert.match(trendSource, /TREND_SNAPSHOT_TIMEOUT_MS,\s*\n?\s*\)/);
  assert.doesNotMatch(
    trendSource,
    /withTimeout\([\s\S]{0,400}?10_000,/,
    "the superseded 10s aggregate race must not come back",
  );
});

test("trend SQL is consolidated to a three-statement budget", () => {
  const trendSource = read(TREND_SOURCE);

  for (const group of ["money", "acquisition"]) {
    assert.match(
      trendSource,
      new RegExp(
        `\\.then\\(\\(result\\) => \\(slots\\.${group} = result\\)\\)`,
      ),
      `group "${group}" must publish into the shared slots object so a timed-out ` +
        `snapshot still serves it`,
    );
  }

  assert.match(
    trendSource,
    /slots\.schemaProbeOk = schemaProbe\.error === null/,
  );

  const fetchBody = trendSource.slice(
    trendSource.indexOf("async function fetchTrendSeriesPg"),
    trendSource.indexOf("/** Uncached PostgreSQL computation"),
  );
  assert.equal(
    fetchBody.match(/queryRows</g)?.length,
    3,
    "a cold trend refresh must use exactly one schema probe and two aggregate statements",
  );
  assert.doesNotMatch(
    fetchBody,
    /dashboard\.trends\.(ledger|upgrader|doubleDown|signups|attribution|ftds)"/,
  );
  assert.match(fetchBody, /WITH customers AS MATERIALIZED/);
  assert.equal(
    fetchBody.match(/FROM ledger_transactions/g)?.length,
    2,
    "ledger must be scanned once for money and once for first deposits, never again for attribution",
  );
});

test("a timed-out trend snapshot degrades to partial data, never to all-false", () => {
  const trendSource = read(TREND_SOURCE);

  // The catch path must rebuild from the slots, not return the empty snapshot.
  assert.match(
    trendSource,
    /catch \{[\s\S]*?return buildTrendSnapshot\(slots, period\);[\s\S]*?\}/,
    "the outer catch must serve whatever legs finished",
  );
  assert.doesNotMatch(
    trendSource,
    /return partial \?\? emptyDashboardTrendSeries\(period\)/,
    "the superseded all-or-nothing fallback must not come back",
  );

  // A degraded snapshot still must not be cached over a good one.
  assert.match(trendSource, /snapshot was incomplete/);
});

test("group publication survives an aggregate timeout (behavioural)", async () => {
  const slots: Record<string, string | null> = {
    money: null,
    acquisition: null,
  };

  const settle = (name: string, ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        slots[name] = `done:${name}`;
        resolve();
      }, ms);
    });

  let timedOut = false;
  try {
    await withTimeout(
      () => Promise.all([settle("money", 5), settle("acquisition", 5_000)]),
      120,
    );
  } catch (err) {
    timedOut = isQueryTimeoutError(err);
  }

  assert.equal(timedOut, true, "the outer bound should have fired");

  assert.equal(slots.money, "done:money");
  assert.equal(
    slots.acquisition,
    null,
    "the slow group must still be unavailable",
  );
});
