// =============================================================================
// Unified Role System — behavior-preservation parity (NO DB).
//
// Proves the parts of the unified-role-system change (RoleV2 P3/P4 + the one
// merged Roles concept) that are PURE and can be pinned into CI without a DB:
//
//   1. LANDING-ROUTE NEUTRALITY (P4): with NO landing_route set (NULL on every
//      role row — today's state), routing is byte-identical to before. The
//      resolver returns null for null/empty/unknown input, and
//      `getDefaultRouteForRoles` returns the SAME route for every existing role
//      combo. This is the "NULL on every row = byte-identical routing" proof.
//
//   2. LANDING-ROUTE VALIDATION (redirect-loop guard, P4): the validator only
//      accepts a KNOWN admin page key; an unknown/typo value normalizes to
//      `undefined` (rejected) and resolves to `null` (fall through), so a bad
//      landing route can never bounce a user into a dead route.
//
//   3. MATERIALIZER BYTE-IDENTITY (frozen sample): the unified-role change does
//      not touch `computeEffectivePermissions`; re-assert the frozen fixture
//      sample reconciles, so a regression in the role surface that perturbed
//      effective access would fail here too.
//
// The server-side `is_system` guards (updateRole/deleteRole reject system rows;
// 2FA on delete/assign) live in `"use server"` modules that import `adminDb` /
// `server-only` and can't load under plain tsx/node:test — their CONTRACT is
// documented here and exercised live by the render-verify pass. The PURE
// guarantees those guards protect (routing neutrality + effective-access
// identity) are what this file pins.
//
// Run via tsx (wired into package.json `test:parity` — it globs this dir):
//   npx tsx --test scripts/__fixtures__/unified-role-system.test.ts
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  getDefaultRouteForRoles,
  getDefaultRoute,
  ALL_ADMIN_ROLES,
  getEffectiveRoles,
  isDedicatedPackBuilder,
} from "@/lib/admin-roles";
import {
  isValidLandingRoute,
  normalizeLandingRouteInput,
  resolveLandingRoute,
} from "@/lib/role-landing";
import { ALL_PAGE_KEYS } from "@/lib/admin-pages";
import { computeEffectivePermissions } from "@/lib/permissions/materialize";
import { sanitizePermissionKeys } from "@/app/(admin)/settings/roles/permissions-utils";

const setEq = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
};

// ── Frozen routing expectations: the EXACT route each role combo resolves to
//    today (from getDefaultRoute's logic). If a future change alters routing
//    for any combo when no landing override is set, this fails. ──────────────
// allowedPages-aware combos use a representative allowed_pages list.
const DASH = ["/dashboard", "/users"];

const ROUTING_CASES: Array<{
  roles: string[];
  allowedPages?: string[];
  expected: string;
}> = [
  { roles: ["admin"], expected: "/dashboard" },
  { roles: ["support"], allowedPages: DASH, expected: "/dashboard" },
  { roles: ["support"], allowedPages: ["/users"], expected: "/users" },
  { roles: ["marketing"], allowedPages: DASH, expected: "/dashboard" },
  { roles: ["creator"], expected: "/my-profile" },
  { roles: ["pack_creator"], expected: "/pack-studio" },
  { roles: ["creator_manager"], expected: "/creator-hub" },
  // Multi-role: highest-privilege primary wins (admin > support > … ).
  { roles: ["support", "pack_creator"], allowedPages: DASH, expected: "/dashboard" },
  { roles: ["support", "pack_creator"], allowedPages: ["/users"], expected: "/users" },
  { roles: ["admin", "support"], expected: "/dashboard" },
  { roles: ["creator_manager", "pack_creator"], expected: "/creator-hub" },
  // Empty roles → falls back to getDefaultRoute("", allowedPages).
  { roles: [], allowedPages: DASH, expected: "/dashboard" },
];

// ── 1. Routing is unchanged for every existing combo (the P4 NULL proof) ─────
test("getDefaultRouteForRoles sends the dedicated Pack Builder role to Pack Studio", () => {
  for (const c of ROUTING_CASES) {
    const got = getDefaultRouteForRoles(c.roles, c.allowedPages);
    assert.equal(
      got,
      c.expected,
      `roles=[${c.roles.join(",")}] allowedPages=${JSON.stringify(c.allowedPages)} → ${got}, expected ${c.expected}`,
    );
  }
});

test("only a single-role Pack Builder is isolated to the Packs webapp", () => {
  assert.equal(isDedicatedPackBuilder(["pack_creator"]), true);
  assert.equal(isDedicatedPackBuilder(["support", "pack_creator"]), false);
  assert.equal(isDedicatedPackBuilder(["admin", "pack_creator"]), false);
});

// ── 1b. NULL/empty landing_route → null (fall through to default routing) ────
test("a NULL or empty landing_route resolves to null (today's routing untouched)", () => {
  assert.equal(resolveLandingRoute(null), null, "null → null");
  assert.equal(resolveLandingRoute(undefined), null, "undefined → null");
  assert.equal(resolveLandingRoute(""), null, "empty string → null");
  // The whole point: with no override on any role, the resolver never overrides,
  // so getDefaultRouteForRoles (which is byte-identical above) is the result.
  for (const c of ROUTING_CASES) {
    assert.equal(
      resolveLandingRoute(null),
      null,
      "every row NULL ⇒ resolver yields null ⇒ default routing is used",
    );
    // sanity: the default routing for this combo is the frozen expectation.
    assert.equal(getDefaultRouteForRoles(c.roles, c.allowedPages), c.expected);
  }
});

// ── 2. Validation: only a known ADMIN_PAGES key is a valid landing target ────
test("landing-route validation accepts known page keys and rejects unknown ones", () => {
  // Every real admin page key is a valid landing target.
  for (const key of ALL_PAGE_KEYS) {
    assert.ok(isValidLandingRoute(key), `${key} should be a valid landing route`);
  }
  // Representative known keys resolve to themselves.
  assert.equal(resolveLandingRoute("/users"), "/users");
  assert.equal(resolveLandingRoute("/dashboard"), "/dashboard");

  // Unknown / typo / dangerous values are rejected (→ null, never a dead route).
  for (const bad of [
    "/not-a-real-page",
    "/users/123", // a sub-route, not a page key
    "https://evil.example.com",
    "javascript:alert(1)",
    "dashboard", // missing leading slash
    "",
  ]) {
    assert.ok(!isValidLandingRoute(bad), `${bad} must NOT be valid`);
    assert.equal(resolveLandingRoute(bad), null, `${bad} resolves to null`);
  }
});

// ── 2b. normalizeLandingRouteInput: persist-time normalization contract ──────
test("normalizeLandingRouteInput maps input to persist value (null clears, undefined rejects)", () => {
  // null / empty / whitespace → null (clear the override).
  assert.equal(normalizeLandingRouteInput(null), null);
  assert.equal(normalizeLandingRouteInput(undefined), null);
  assert.equal(normalizeLandingRouteInput(""), null);
  assert.equal(normalizeLandingRouteInput("   "), null);
  // A known key → that key (trimmed).
  assert.equal(normalizeLandingRouteInput("/users"), "/users");
  assert.equal(normalizeLandingRouteInput("  /dashboard  "), "/dashboard");
  // An unknown value → undefined (the action REJECTS this; never stored).
  assert.equal(normalizeLandingRouteInput("/nope"), undefined);
  assert.equal(normalizeLandingRouteInput("garbage"), undefined);
});

// ── 3. getDefaultRoute single-role landing (admin always /dashboard) ─────────
test("admin always routes to /dashboard regardless of allowedPages (superuser bypass)", () => {
  assert.equal(getDefaultRoute("admin"), "/dashboard");
  assert.equal(getDefaultRoute("admin", ["/users", "/packs"]), "/dashboard");
  // Multi-role including admin too.
  assert.equal(getDefaultRouteForRoles(["support", "admin"], ["/users"]), "/dashboard");
});

// ── 4. Materializer byte-identity from the frozen fixture (unchanged) ────────
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

test("frozen fixture sample still reconciles under computeEffectivePermissions (unified-role change is behavior-neutral)", () => {
  assert.ok(fixture.users.length > 0, "fixture must have users");
  for (const u of fixture.users) {
    const roles = getEffectiveRoles(u.role, u.roles);
    const effective = computeEffectivePermissions({
      role: u.role,
      roles: u.roles,
      customRoleTokens: u.customRoleTokens,
      override: u.override,
    });
    if (roles.includes("admin")) {
      assert.deepEqual(effective, [], `${u.username}: admin → [] bypass`);
    } else {
      const stored = sanitizePermissionKeys(u.allowedPages);
      assert.ok(
        setEq(effective, stored),
        `${u.username}: effective must set-equal stored allowed_pages`,
      );
    }
  }
});

// ── 5. ALL_ADMIN_ROLES is the unchanged 6-role backbone ──────────────────────
test("the six enum roles are the unchanged backbone", () => {
  assert.deepEqual(
    [...ALL_ADMIN_ROLES],
    ["admin", "support", "marketing", "creator", "pack_creator", "creator_manager"],
    "ALL_ADMIN_ROLES must stay the 6-role backbone",
  );
});
