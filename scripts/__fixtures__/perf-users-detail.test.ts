import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Read-budget guardrail for /users/[id].
 *
 * Every MAIN read on this route passes through a process-wide admission
 * semaphore sized to the mirror pool (src/lib/db.ts), so what decides whether
 * the per-leg safeQuery budget holds is the TOTAL number of reads ONE render
 * issues — not how fast any single read is. Adding "just one more round trip"
 * to this page is the regression this file exists to catch.
 *
 * These assertions pin the SHAPE (how many acquisitions, is the fan-out
 * bounded, is each optional read tab-gated), never a tuning number — pool
 * sizes, timeouts and TTLs stay free to move.
 *
 * Source is read with readFileSync on purpose: a root fixture must never
 * runtime-import route/query modules (they pull in server-only, next/cache and
 * the DB clients).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const detailSource = readFileSync(
  path.join(root, "src/lib/queries/users-detail.ts"),
  "utf8",
);
const pageSource = readFileSync(
  path.join(root, "src/app/(admin)/users/[id]/page.tsx"),
  "utf8",
);

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("the detail aggregate resolves in exactly three MAIN legs", () => {
  // core statement + calculateUserPnl + getUserTips. Anything new belongs
  // INSIDE the core statement, not as a fourth acquisition.
  assert.match(
    detailSource,
    /const \[core, userPnl, tips\] = await Promise\.all\(\[/,
    "getUserDetail must fan out over exactly core / userPnl / tips",
  );
  // getUserHeader, runUserDetailCoreQuery, getUserTips — and nothing else.
  assert.equal(
    occurrences(detailSource, "queryMainRows<"),
    3,
    "a new queryMainRows call site in users-detail.ts is a new mirror acquisition",
  );
});

test("battle limits, wager breakdown and referral counts stay folded into the core statement", () => {
  // Each of these used to be its own round trip over an index the core
  // statement already touches.
  assert.match(detailSource, /\), ledger_agg AS \(/);
  assert.match(detailSource, /AS pack_opening_total/);
  assert.match(detailSource, /AS battle_sponsorship_total/);
  assert.match(detailSource, /AS owned_code_referral_counts/);
  assert.match(detailSource, /AS battle_limits/);
  assert.doesNotMatch(
    detailSource,
    /SELECT \* FROM user_battle_limits/,
    "user_battle_limits must not be re-split into its own round trip",
  );
});

test("leaderboard titles are folded into the existing prizes statement", () => {
  // A timed-out Promise.race does not cancel backend retries or their per-id
  // PostgreSQL fallbacks. Resolve the cosmetic title in the already-required
  // tips/prizes statement so no work survives the page result.
  assert.match(detailSource, /FROM affiliate_leaderboards al/);
  assert.match(detailSource, /AS leaderboard_title/);
  assert.doesNotMatch(detailSource, /affiliateLeaderboardsApi/);
  assert.doesNotMatch(detailSource, /Promise\.allSettled/);
  assert.match(detailSource, /function enrichLeaderboardWins\(/);
  assert.doesNotMatch(detailSource, /async function enrichLeaderboardWins\(/);
});

test("the streamed body resolves its reads in a single awaited gate", () => {
  const body = pageSource.slice(pageSource.indexOf("async function UserDetailBody("));
  assert.equal(
    occurrences(body, "await Promise.all("),
    1,
    "extra await layers in the streamed body serialize independent reads",
  );
});

test("every optional per-tab read stays gated on the active tab", () => {
  // Active-Timeframe-Only: a hidden tab must never pay for its data. Each of
  // these promises has to remain conditional on initialTab.
  for (const [name, gate] of [
    ["pnlResultPromise", "wantsPnl"],
    ["gamingTxPromise", "wantsGamingTx"],
    ["financialTxPromise", "wantsFinancialTx"],
    ["inventoryPromise", 'initialTab === "inventory"'],
    ["disposedInventoryPromise", 'initialTab === "inventory"'],
    ["rewardsPromise", 'initialTab === "rewards"'],
    ["rewardPackOpensPromise", 'initialTab === "rewards"'],
    ["featureLocksPromise", 'initialTab === "account"'],
    ["fiatDepositAccessPromise", 'initialTab === "account"'],
    ["preFiatOverridePromise", 'initialTab === "account"'],
    ["kycPromise", 'initialTab === "kyc"'],
    ["auditPromise", 'initialTab === "audit"'],
  ] as const) {
    const declaration = pageSource.slice(
      pageSource.indexOf(`const ${name}`),
      pageSource.indexOf(`const ${name}`) + 400,
    );
    assert.ok(
      declaration.includes(gate),
      `${name} must stay gated on the active tab (expected ${gate})`,
    );
  }
});
