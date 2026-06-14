// =============================================================================
// CI parity test (NO DB) — re-asserts the Phase A behavior-preservation proof
// from a committed fixture, using the REAL `computeEffectivePermissions`.
//
// The live read-only harness (scripts/permission-parity-harness.mjs) proves
// parity against the actual ADMIN DB; this test pins that same proof into CI
// so a future change to the baselines / materializer / sanitizer that would
// alter any of the 17 users' effective access fails the build with no DB
// access required.
//
// Run via tsx (see package.json `test:parity`):
//   npx tsx --test scripts/__fixtures__/parity-fixture.test.ts
//
// The fixture (parity-fixture.json) is admin role/permission CONFIG only — no
// secrets. See ROLE_REDESIGN_DESIGN.md §"New code (Phase A)".
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { computeEffectivePermissions } from "@/lib/permissions/materialize";
import {
  ROLE_BASELINES,
  baselineTokensFor,
} from "@/lib/role-baselines";
import {
  sanitizePermissionKeys,
  isValueToken,
} from "@/app/(admin)/settings/roles/permissions-utils";
import { HARNESS_ROLE_BASELINES } from "../permission-parity-harness.mjs";
import { getEffectiveRoles } from "@/lib/admin-roles";

// NOTE: the lock-step between ROLE_BASELINES.pack_creator and the runtime
// PACK_CREATOR_DEFAULT_PAGES (src/lib/pack-creator/ensure-capabilities.ts) is
// NOT asserted here — that module is `server-only` (imports adminDb) and can't
// be loaded in a plain node:test/tsx context. The link is enforced instead by
// the LIVE harness (Skailer's parity breaks if the pack_creator baseline ever
// diverges from his stored 24-token array) and by tsc.

type FixtureUser = {
  username: string;
  role: string;
  roles: string[];
  customRoleTokens: string[];
  allowedPages: string[];
  override: { grants: string[]; revokes: string[] };
};
type Fixture = { userCount: number; users: FixtureUser[] };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "parity-fixture.json"), "utf8"),
) as Fixture;

const setEq = (a: string[], b: string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
};

// ── 1. Per-user parity through the REAL materializer ─────────────────────────
test("all fixture users reconcile under computeEffectivePermissions", () => {
  assert.equal(fixture.users.length, 17, "expected 17 admin users in fixture");

  for (const u of fixture.users) {
    const roles = getEffectiveRoles(u.role, u.roles);
    const isAdmin = roles.includes("admin");
    const storedSanitized = sanitizePermissionKeys(u.allowedPages);

    const effective = computeEffectivePermissions({
      role: u.role,
      roles: u.roles,
      customRoleTokens: u.customRoleTokens,
      override: u.override,
    });

    if (isAdmin) {
      // Gate-visible: admins bypass → effective [].
      assert.deepEqual(
        effective,
        [],
        `${u.username}: admin must materialize to [] (gate bypass)`,
      );
      // Stored array round-trips: admin baseline ([]) ∪ grants \ revokes.
      const revokeSet = new Set(u.override.revokes);
      const roundTrip = sanitizePermissionKeys(
        [...baselineTokensFor("admin"), ...u.override.grants].filter(
          (k) => !revokeSet.has(k),
        ),
      );
      assert.ok(
        setEq(roundTrip, storedSanitized),
        `${u.username}: admin stored array must round-trip under the override model`,
      );
    } else {
      assert.ok(
        setEq(effective, storedSanitized),
        `${u.username}: effective (${effective.length}) must set-equal stored allowed_pages (${storedSanitized.length})`,
      );
    }
  }
});

// ── 2. Drift guard: harness embedded baselines == real ROLE_BASELINES ────────
test("harness embedded baselines match the source ROLE_BASELINES", () => {
  for (const role of Object.keys(ROLE_BASELINES) as (keyof typeof ROLE_BASELINES)[]) {
    const real = ROLE_BASELINES[role].tokens;
    const harness = (HARNESS_ROLE_BASELINES as Record<string, string[]>)[role];
    assert.ok(harness, `harness missing baseline for role ${role}`);
    assert.ok(
      setEq(real, harness),
      `harness baseline for ${role} drifted from ROLE_BASELINES`,
    );
  }
});

// ── 3. baseline cardinalities match the brief (support 16 / pack_creator 24) ─
test("built-in baselines have the canonical cardinalities", () => {
  assert.equal(ROLE_BASELINES.support.tokens.length, 16, "support baseline = 16 tokens");
  assert.equal(
    ROLE_BASELINES.pack_creator.tokens.length,
    24,
    "pack_creator baseline = 24 tokens",
  );
  // No duplicates within a baseline.
  for (const role of Object.keys(ROLE_BASELINES) as (keyof typeof ROLE_BASELINES)[]) {
    const toks = ROLE_BASELINES[role].tokens;
    assert.equal(
      new Set(toks).size,
      toks.length,
      `${role} baseline must have no duplicate tokens`,
    );
  }
});

// ── 4. admin baseline is the empty total-bypass sentinel ─────────────────────
test("admin baseline is [] with bypass=true", () => {
  assert.deepEqual(ROLE_BASELINES.admin.tokens, []);
  assert.equal(ROLE_BASELINES.admin.bypass, true);
  // The unused roles are empty but NOT bypass.
  for (const role of ["marketing", "creator", "creator_manager"] as const) {
    assert.deepEqual(ROLE_BASELINES[role].tokens, []);
    assert.equal(ROLE_BASELINES[role].bypass, false);
  }
});

// ── 5. value-token-aware sanitize preserves limits, drops unknowns ───────────
test("sanitizePermissionKeys is value-token-aware", () => {
  // void's token must survive (the regression the rebuild fixes).
  assert.ok(isValueToken("__balance_limit_daily:10"));
  assert.ok(
    sanitizePermissionKeys(["__balance_limit_daily:10"]).includes(
      "__balance_limit_daily:10",
    ),
    "must preserve __balance_limit_daily:10",
  );
  // Current per-capability limit format also recognized.
  assert.ok(isValueToken("__can_adjust_balance_limit_weekly:500"));
  // Genuinely-unknown value tokens are still dropped.
  assert.equal(isValueToken("__nonsense:5"), false);
  assert.equal(isValueToken("__balance_limit_daily:0"), false); // ≤ 0 rejected
  assert.deepEqual(
    sanitizePermissionKeys(["__nonsense:5", "/totally-not-a-page", "__balance_limit_daily:abc"]),
    [],
    "unknown keys and malformed value tokens must be dropped",
  );
  // A real page + the value token together round-trip.
  assert.ok(
    setEq(sanitizePermissionKeys(["/users", "__balance_limit_daily:10", "/users"]), [
      "/users",
      "__balance_limit_daily:10",
    ]),
  );
});
