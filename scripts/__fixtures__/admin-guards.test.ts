// =============================================================================
// Phase D safety-guard unit tests (NO DB).
//
// Proves the PURE decision logic behind the four owner-approved guards using
// the real helpers in src/lib/admin-guards.ts:
//   • last-admin guard      — wouldDropLastActiveAdmin
//   • self-demotion guard   — wouldRemoveOwnAdminViaRoles / wouldReduceOwnAccessViaOverride
//   • session revocation    — isSessionRevoked (iat seconds vs watermark)
//   • mandatory-2FA flag     — mandatory2faEnabledFromValue (default ON)
//   • role helper            — roleSetHasAdmin
//
// The DB-touching helpers (countOtherActiveEffectiveAdmins, isMandatory2faEnabled)
// are NOT imported — they only wrap a query around these pure functions and
// can't load in a plain tsx/node:test context (they import adminDb). Their
// decision logic IS the pure functions exercised below.
//
// Run via tsx (wired into package.json `test:parity`):
//   npx tsx --test scripts/__fixtures__/admin-guards.test.ts
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  roleSetHasAdmin,
  wouldDropLastActiveAdmin,
  wouldRemoveOwnAdminViaRoles,
  wouldReduceOwnAccessViaOverride,
  isSessionRevoked,
  mandatory2faEnabledFromValue,
  canUsePasskeyGrace,
} from "@/lib/admin-guards";

// ── roleSetHasAdmin ───────────────────────────────────────────────────────────
test("roleSetHasAdmin: admin via primary role, via roles array, and absent", () => {
  assert.equal(roleSetHasAdmin("admin", []), true, "primary admin");
  assert.equal(roleSetHasAdmin("support", ["support", "admin"]), true, "admin in roles");
  assert.equal(roleSetHasAdmin("support", ["support"]), false, "no admin");
  assert.equal(roleSetHasAdmin("support", null), false, "null roles, non-admin primary");
  // Unknown/garbage role strings are dropped by getEffectiveRoles → not admin.
  assert.equal(roleSetHasAdmin("ADMIN", []), false, "case-sensitive: not the enum");
});

test("canUsePasskeyGrace: permits only admins and owners", () => {
  assert.equal(
    canUsePasskeyGrace({
      role: "admin",
      roles: ["admin"],
      username: "staff",
      isOwner: false,
    }),
    true,
  );
  assert.equal(
    canUsePasskeyGrace({
      role: "support",
      roles: ["support"],
      username: "owner",
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    canUsePasskeyGrace({
      role: "support",
      roles: ["support"],
      username: "MoThA",
      isOwner: false,
    }),
    true,
  );
  assert.equal(
    canUsePasskeyGrace({
      role: "support",
      roles: ["support"],
      username: "staff",
      isOwner: false,
    }),
    false,
  );
});

// ── Guard 1: last-admin ───────────────────────────────────────────────────────
test("wouldDropLastActiveAdmin: blocks removing the sole active admin", () => {
  // Target is the only active admin (0 others), losing admin → BLOCK.
  assert.equal(
    wouldDropLastActiveAdmin({
      targetIsActiveAdminNow: true,
      targetStaysActiveAdmin: false,
      otherActiveAdminCount: 0,
    }),
    true,
    "sole admin demotion blocked",
  );
});

test("wouldDropLastActiveAdmin: allows when another active admin remains", () => {
  assert.equal(
    wouldDropLastActiveAdmin({
      targetIsActiveAdminNow: true,
      targetStaysActiveAdmin: false,
      otherActiveAdminCount: 1,
    }),
    false,
    "another admin exists → allowed",
  );
});

test("wouldDropLastActiveAdmin: no-op when target keeps admin or isn't admin", () => {
  // Target stays admin (e.g. role edit that keeps admin) → never blocks.
  assert.equal(
    wouldDropLastActiveAdmin({
      targetIsActiveAdminNow: true,
      targetStaysActiveAdmin: true,
      otherActiveAdminCount: 0,
    }),
    false,
    "stays admin → not blocked",
  );
  // Target isn't an active admin today → removing 'their' admin can't drop the count.
  assert.equal(
    wouldDropLastActiveAdmin({
      targetIsActiveAdminNow: false,
      targetStaysActiveAdmin: false,
      otherActiveAdminCount: 0,
    }),
    false,
    "non-admin target → not blocked",
  );
});

// ── Guard 2: self-demotion (roles) ────────────────────────────────────────────
test("wouldRemoveOwnAdminViaRoles: blocks self stripping own admin", () => {
  assert.equal(
    wouldRemoveOwnAdminViaRoles({
      isSelf: true,
      currentlyAdmin: true,
      newRoles: ["support"],
    }),
    true,
    "self + admin → support: blocked",
  );
});

test("wouldRemoveOwnAdminViaRoles: allows self keeping admin", () => {
  assert.equal(
    wouldRemoveOwnAdminViaRoles({
      isSelf: true,
      currentlyAdmin: true,
      newRoles: ["admin", "support"],
    }),
    false,
    "self keeps admin → allowed",
  );
});

test("wouldRemoveOwnAdminViaRoles: never blocks editing someone else", () => {
  assert.equal(
    wouldRemoveOwnAdminViaRoles({
      isSelf: false,
      currentlyAdmin: true,
      newRoles: ["support"],
    }),
    false,
    "other target → not self-demotion",
  );
});

test("wouldRemoveOwnAdminViaRoles: no-op when actor wasn't admin", () => {
  assert.equal(
    wouldRemoveOwnAdminViaRoles({
      isSelf: true,
      currentlyAdmin: false,
      newRoles: ["support"],
    }),
    false,
    "non-admin self → nothing to remove",
  );
});

// ── Guard 2: self-demotion (override / access reduction) ──────────────────────
test("wouldReduceOwnAccessViaOverride: blocks self removing a held token", () => {
  assert.equal(
    wouldReduceOwnAccessViaOverride({
      isSelf: true,
      currentAllowed: ["/users", "/packs", "__can_ban_users"],
      nextAllowed: ["/users", "/packs"], // dropped __can_ban_users
    }),
    true,
    "self removing own capability → blocked",
  );
});

test("wouldReduceOwnAccessViaOverride: allows self adding access", () => {
  assert.equal(
    wouldReduceOwnAccessViaOverride({
      isSelf: true,
      currentAllowed: ["/users"],
      nextAllowed: ["/users", "/packs"], // only added
    }),
    false,
    "self adding access → allowed",
  );
});

test("wouldReduceOwnAccessViaOverride: never blocks editing someone else", () => {
  assert.equal(
    wouldReduceOwnAccessViaOverride({
      isSelf: false,
      currentAllowed: ["/users", "/packs"],
      nextAllowed: [],
    }),
    false,
    "other target → not self-reduction",
  );
});

// ── Guard 3: session revocation (iat seconds vs watermark) ────────────────────
test("isSessionRevoked: no watermark → never revoked", () => {
  assert.equal(isSessionRevoked(1_000_000, null), false, "null watermark");
  assert.equal(isSessionRevoked(1_000_000, undefined), false, "undefined watermark");
});

test("isSessionRevoked: token issued before watermark is revoked", () => {
  const watermark = new Date("2026-06-14T12:00:00.000Z");
  const watermarkSec = Math.floor(watermark.getTime() / 1000);
  // iat one second before the watermark → revoked.
  assert.equal(isSessionRevoked(watermarkSec - 1, watermark), true, "iat < watermark");
});

test("isSessionRevoked: token issued at/after watermark survives", () => {
  const watermark = new Date("2026-06-14T12:00:00.000Z");
  const watermarkSec = Math.floor(watermark.getTime() / 1000);
  // Same second is NOT before → kept (a token minted exactly at revoke time, or
  // a fresh login right after, must survive).
  assert.equal(isSessionRevoked(watermarkSec, watermark), false, "iat == watermark kept");
  assert.equal(isSessionRevoked(watermarkSec + 60, watermark), false, "iat > watermark kept");
});

test("isSessionRevoked: missing iat is treated as epoch → revoked when watermark set", () => {
  const watermark = new Date("2026-06-14T12:00:00.000Z");
  assert.equal(isSessionRevoked(undefined, watermark), true, "no iat + watermark → revoked");
  assert.equal(isSessionRevoked(null, watermark), true, "null iat + watermark → revoked");
});

test("isSessionRevoked: accepts a string watermark (cache/JSON path) and bad input", () => {
  // unstable_cache / JSON can hand back an ISO string instead of a Date.
  assert.equal(
    isSessionRevoked(1_700_000_000, "2026-06-14T12:00:00.000Z"),
    true,
    "string watermark, old iat → revoked",
  );
  // An unparseable watermark must NOT revoke (fail-open so a bad value can't
  // lock everyone out).
  assert.equal(isSessionRevoked(1_700_000_000, "not-a-date"), false, "bad watermark → not revoked");
});

// ── Guard 4: mandatory-2FA flag (default ON) ──────────────────────────────────
test("mandatory2faEnabledFromValue: unset (null) → ON", () => {
  assert.equal(mandatory2faEnabledFromValue(null), true, "unset defaults ON");
});

test("mandatory2faEnabledFromValue: only explicit 'false' turns it OFF", () => {
  assert.equal(mandatory2faEnabledFromValue("false"), false, "'false' → OFF");
  assert.equal(mandatory2faEnabledFromValue("FALSE"), false, "case-insensitive OFF");
  assert.equal(mandatory2faEnabledFromValue("  false  "), false, "trimmed OFF");
  assert.equal(mandatory2faEnabledFromValue("true"), true, "'true' → ON");
  assert.equal(mandatory2faEnabledFromValue("1"), true, "any other value → ON");
  assert.equal(mandatory2faEnabledFromValue(""), true, "empty string → ON");
});
