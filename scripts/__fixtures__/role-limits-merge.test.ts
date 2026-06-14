// =============================================================================
// role-limits-merge.test.ts — per-ROLE balance-limit merge proof (NO DB).
//
// Proves the spend-time cap resolution that `checkBalanceAdjustmentLimit`
// (src/lib/balance-limits.ts) applies, using the REAL pure helpers:
//   • resolveEffectiveCap   — userMax ?? roleDefault ?? null  (per-period)
//   • mergeRoleBalanceLimits — smallest non-null per period across roles
// Both are the exact functions the enforcement path calls (no replica), so
// these assertions can't silently drift from runtime behavior.
//
// The four required cases:
//   1. per-user row present  ⇒ per-user wins (even over a role default)
//   2. only a role default   ⇒ the role default applies
//   3. neither               ⇒ unlimited (null ⇒ no cap ⇒ no throw)
//   4. multi-role            ⇒ smallest non-null wins (tightest cap)
//
// Run via tsx (wired into package.json `test:parity`):
//   npx tsx --test scripts/__fixtures__/role-limits-merge.test.ts
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

// Import from the dependency-free pure module (no adminDb / server-only) so
// the test loads under plain `tsx --test`. `role-limits.ts` re-exports these
// same functions; the enforcement path (balance-limits.ts) uses them too.
import {
  mergeRoleBalanceLimits,
  resolveEffectiveCap,
  EMPTY_ROLE_BALANCE_LIMIT_DEFAULTS,
  type RoleBalanceLimitRow,
} from "@/lib/role-limits-merge";

// ── Case 1: per-user row present ⇒ per-user WINS (over the role default) ──────
test("per-user row wins over the role default for that period", () => {
  // role default daily=500, per-user daily=10 → effective 10 (per-user wins).
  assert.equal(resolveEffectiveCap(10, 500), 10, "per-user smaller wins");
  // per-user also wins when it is LARGER than the role default (it's not a
  // min() — the per-user row is the authoritative override).
  assert.equal(resolveEffectiveCap(900, 500), 900, "per-user larger still wins");
  // per-user=0 is not a thing (schema requires positive), but a real per-user
  // row of e.g. 50 with no role default resolves to 50.
  assert.equal(resolveEffectiveCap(50, null), 50, "per-user with no role default");
});

// ── Case 2: only a role default ⇒ the role default applies ───────────────────
test("role default applies when there is no per-user row", () => {
  assert.equal(resolveEffectiveCap(undefined, 500), 500, "undefined per-user → role default");
  assert.equal(resolveEffectiveCap(null, 500), 500, "null per-user → role default");
});

// ── Case 3: neither ⇒ unlimited (null ⇒ no cap) ──────────────────────────────
test("no per-user row and no role default ⇒ unlimited (null)", () => {
  assert.equal(resolveEffectiveCap(undefined, null), null, "both absent → null");
  assert.equal(resolveEffectiveCap(null, undefined), null, "both nullish → null");
  assert.equal(resolveEffectiveCap(undefined, undefined), null, "both undefined → null");
});

// ── Case 4: multi-role ⇒ smallest non-null wins (tightest cap) ───────────────
test("multi-role role defaults collapse to the smallest non-null per period", () => {
  // Two roles: one caps daily=500/weekly=null/monthly=2000, another caps
  // daily=100/weekly=300/monthly=null. Tightest per period:
  //   daily   = min(500,100)      = 100
  //   weekly  = min(—  ,300)      = 300
  //   monthly = min(2000, —)      = 2000
  const rows: RoleBalanceLimitRow[] = [
    { daily: 500, weekly: null, monthly: 2000 },
    { daily: 100, weekly: 300, monthly: null },
  ];
  const merged = mergeRoleBalanceLimits(rows);
  assert.deepEqual(
    merged,
    { daily: 100, weekly: 300, monthly: 2000 },
    "smallest non-null per period",
  );
});

// ── Merge edge: all-null rows ⇒ all-null defaults (today's inert state) ───────
test("all-null role rows merge to all-null defaults (inert)", () => {
  const rows: RoleBalanceLimitRow[] = [
    { daily: null, weekly: null, monthly: null },
    { daily: null, weekly: null, monthly: null },
  ];
  assert.deepEqual(
    mergeRoleBalanceLimits(rows),
    { daily: null, weekly: null, monthly: null },
    "all NULL ⇒ no role-level cap (matches every role today)",
  );
});

// ── Merge edge: no rows at all ⇒ all-null ────────────────────────────────────
test("zero role rows merge to all-null defaults", () => {
  assert.deepEqual(mergeRoleBalanceLimits([]), {
    daily: null,
    weekly: null,
    monthly: null,
  });
});

// ── End-to-end-ish: merge → resolve, with all-null defaults (today) ──────────
test("with all-null role defaults, effective cap == per-user-or-unlimited", () => {
  // Mirrors the parity-harness invariant in pure form: when roleDefault is
  // null (today), effective === userMax ?? null === per-user-or-unlimited.
  const defaults = mergeRoleBalanceLimits([
    { daily: null, weekly: null, monthly: null },
  ]);
  assert.deepEqual(defaults, EMPTY_ROLE_BALANCE_LIMIT_DEFAULTS);

  // A user with a per-user daily=10 and no role cap → daily 10, weekly/monthly null.
  assert.equal(resolveEffectiveCap(10, defaults.daily), 10);
  assert.equal(resolveEffectiveCap(undefined, defaults.weekly), null);
  assert.equal(resolveEffectiveCap(undefined, defaults.monthly), null);

  // A user with NO per-user cap and (today) no role cap → fully unlimited.
  assert.equal(resolveEffectiveCap(undefined, defaults.daily), null);
});
