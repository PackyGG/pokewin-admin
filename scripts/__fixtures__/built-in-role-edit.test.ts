// =============================================================================
// RoleV2 P2 — built-in (system) role EDIT re-materialization unit tests (NO DB).
//
// Proves the PURE math that `updateBuiltInRole`
// (src/app/(admin)/admin-users/_roles/built-in-roles-actions.ts) relies on when
// it rewrites a built-in role's `capabilities` and re-materializes every
// affected user. The server action's only non-pure work is a DB read/write +
// audit + cache bust; the permission math it delegates to is exercised here
// directly via the REAL helpers, with an INJECTED baseline map standing in for
// the DB-backed `getBaselineMap()`:
//   • computeEffectivePermissions  (src/lib/permissions/materialize.ts)
//   • effectiveOverrideFor / materializeForOverride / baselineUnionFor
//                                  (src/lib/permissions/override.ts)
//
// The action's behavior-preservation contract, restated as the property under
// test: for each affected user,
//     new allowed_pages == NEW_baseline(role) ∪ grants \ revokes
// where the override is the user's explicit {grants,revokes} if set, else the
// override DERIVED from their current allowed_pages vs the OLD baseline. Users
// whose effective roles do NOT include the edited role are unchanged, and
// `admin` users are excluded (the materializer short-circuits to []).
//
// The DB glue (loadUserPermissionState, getEffectiveRoles membership scan) is
// NOT imported — it can't load in a plain tsx/node:test context (server-only /
// adminDb). Its logic beyond the DB read is the pure composition below.
//
// Run via tsx (wired into package.json `test:parity` — it globs this dir):
//   npx tsx --test scripts/__fixtures__/built-in-role-edit.test.ts
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeEffectivePermissions } from "@/lib/permissions/materialize";
import {
  baselineUnionFor,
  effectiveOverrideFor,
  materializeForOverride,
  type PermissionStateCore,
} from "@/lib/permissions/override";
import { ROLE_BASELINES } from "@/lib/role-baselines";
import type { BaselineMap } from "@/lib/role-baselines";

const setEq = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
};

const SUPPORT = ROLE_BASELINES.support.tokens;
const PACK = ROLE_BASELINES.pack_creator.tokens;

/**
 * Reproduce, with PURE helpers, exactly what `updateBuiltInRole` does to one
 * user: derive the override against the OLD baseline map, then materialize
 * against the NEW baseline map. (Admins are filtered out before this in the
 * action; we assert that separately.)
 */
function rematerializeForBuiltInEdit(
  state: PermissionStateCore,
  oldBaselines: BaselineMap | undefined,
  newBaselines: BaselineMap | undefined,
): string[] {
  const override = effectiveOverrideFor(state, oldBaselines);
  return materializeForOverride(state, override, newBaselines);
}

// ── 1. Affected never-edited user adopts the NEW baseline (no overrides) ──────
test("editing a built-in role: a plain member adopts new baseline ∪ {} \\ {}", () => {
  // OLD support baseline = code; NEW support baseline = code MINUS /chat PLUS /packs.
  const oldBaselines: BaselineMap = { support: [...SUPPORT] };
  const newSupport = [...SUPPORT.filter((t) => t !== "/chat"), "/packs"];
  const newBaselines: BaselineMap = { support: newSupport };

  // A support user with NO manual adjustments: allowed_pages == OLD baseline,
  // override columns empty.
  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: [...SUPPORT],
    override: { grants: [], revokes: [] },
  };

  const out = rematerializeForBuiltInEdit(state, oldBaselines, newBaselines);
  // No override → effective is exactly the NEW baseline.
  assert.ok(setEq(out, newSupport), "plain member == new baseline");
  assert.ok(out.includes("/packs"), "new baseline addition present");
  assert.ok(!out.includes("/chat"), "new baseline removal applied");
});

// ── 2. Manual GRANT survives the edit (allowed = newBaseline ∪ grant) ─────────
test("editing a built-in role: a never-edited user's manual grant survives", () => {
  const oldBaselines: BaselineMap = { support: [...SUPPORT] };
  // NEW baseline drops /shifts.
  const newSupport = SUPPORT.filter((t) => t !== "/shifts");
  const newBaselines: BaselineMap = { support: [...newSupport] };

  // Support user manually granted /analytics (a non-baseline page), override
  // columns still empty → the grant is encoded in allowed_pages vs OLD baseline.
  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: [...SUPPORT, "/analytics"],
    override: { grants: [], revokes: [] },
  };

  const out = rematerializeForBuiltInEdit(state, oldBaselines, newBaselines);
  // Expected: NEW baseline ∪ {/analytics}. /shifts now gone (baseline removal),
  // /analytics preserved (manual grant).
  const expected = [...new Set([...newSupport, "/analytics"])];
  assert.ok(setEq(out, expected), "newBaseline ∪ {grant}");
  assert.ok(out.includes("/analytics"), "manual grant preserved");
  assert.ok(!out.includes("/shifts"), "baseline removal applied under a grant");
});

// ── 3. Manual REVOKE survives the edit (revoke wins over new baseline too) ────
test("editing a built-in role: a manual revoke still wins against the new baseline", () => {
  const oldBaselines: BaselineMap = { support: [...SUPPORT] };
  // NEW baseline ADDS /packs (so it would re-grant a page the user removed if
  // the revoke weren't preserved).
  const newSupport = [...SUPPORT, "/packs"];
  const newBaselines: BaselineMap = { support: newSupport };

  // Support user who manually revoked /withdrawals (a non-sticky baseline
  // page), empty override
  // columns → revoke encoded as the gap (baseline \ allowed).
  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: SUPPORT.filter((t) => t !== "/withdrawals"),
    override: { grants: [], revokes: [] },
  };

  const out = rematerializeForBuiltInEdit(state, oldBaselines, newBaselines);
  // Expected: NEW baseline with /withdrawals still revoked.
  const expected = newSupport.filter((t) => t !== "/withdrawals");
  assert.ok(setEq(out, expected), "newBaseline \\ {revoke}");
  assert.ok(!out.includes("/withdrawals"), "manual revoke survives the edit");
  assert.ok(out.includes("/packs"), "new baseline addition still applied");
});

// ── 4. EXPLICIT override columns are used verbatim (not re-derived) ───────────
test("editing a built-in role: explicit grants/revokes apply against the new baseline", () => {
  const oldBaselines: BaselineMap = { support: [...SUPPORT] };
  const newSupport = [...SUPPORT, "/cards"];
  const newBaselines: BaselineMap = { support: newSupport };

  // Already-edited user: explicit override columns set. allowed_pages is left
  // intentionally stale to prove the explicit override is used, not re-derived.
  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: SUPPORT, // stale on purpose
    override: { grants: ["/analytics"], revokes: ["/withdrawals"] },
  };

  const out = rematerializeForBuiltInEdit(state, oldBaselines, newBaselines);
  // Expected: NEW baseline ∪ {/analytics} \ {/withdrawals}.
  const expected = [
    ...new Set([...newSupport, "/analytics"]),
  ].filter((t) => t !== "/withdrawals");
  assert.ok(setEq(out, expected), "newBaseline ∪ explicit grants \\ explicit revokes");
  assert.ok(out.includes("/analytics"), "explicit grant applied");
  assert.ok(!out.includes("/withdrawals"), "explicit revoke applied");
  assert.ok(out.includes("/cards"), "new baseline addition applied");
});

// ── 5. Value token (balance limit) survives a built-in edit as a grant ────────
test("editing a built-in role: a value token round-trips through the edit", () => {
  const oldBaselines: BaselineMap = { support: [...SUPPORT] };
  const newSupport = [...SUPPORT, "/packs"];
  const newBaselines: BaselineMap = { support: newSupport };

  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: [...SUPPORT, "__balance_limit_daily:10"],
    override: { grants: [], revokes: [] },
  };

  const out = rematerializeForBuiltInEdit(state, oldBaselines, newBaselines);
  assert.ok(
    out.includes("__balance_limit_daily:10"),
    "value token preserved through a built-in edit",
  );
  assert.ok(out.includes("/packs"), "new baseline addition applied alongside value token");
});

// ── 6. NON-member (effective roles exclude the edited role) is unchanged ──────
test("editing a built-in role: a non-member's materialized set is unaffected", () => {
  // We edit `support`. A pack_creator-only user is NOT a member.
  // Per the action: such a user is never collected, so their allowed_pages is
  // never rewritten. The materializer proves it: with support edited, a
  // pack_creator's effective set is still the pack_creator baseline.
  const newBaselines: BaselineMap = {
    support: [...SUPPORT, "/packs", "/analytics"], // support edited — irrelevant to pack_creator
    pack_creator: [...PACK],
  };

  const eff = computeEffectivePermissions({
    role: "pack_creator",
    roles: ["pack_creator"],
    customRoleTokens: [],
    override: { grants: [], revokes: [] },
    baselines: newBaselines,
  });
  assert.ok(setEq(eff, PACK), "pack_creator unchanged when support is edited");
  assert.ok(!eff.includes("/analytics"), "support's new token did not leak to pack_creator");
});

// ── 7. ADMIN is excluded — materializes to [] regardless of any baseline ──────
test("editing a built-in role: admin is excluded (bypass [] even if a map has an admin entry)", () => {
  // Even if someone seeded an `admin` baseline into the map, the materializer
  // short-circuits to [] for any effective-admin user BEFORE reading baselines.
  const newBaselines: BaselineMap = {
    // Intentionally non-empty admin entry to prove it can't widen/narrow access.
    admin: ["/dashboard", "/users", "__can_ban_users"] as string[],
    support: [...SUPPORT],
  };

  const effAdmin = computeEffectivePermissions({
    role: "admin",
    roles: ["admin"],
    customRoleTokens: [],
    override: { grants: ["/packs"], revokes: [] },
    baselines: newBaselines,
  });
  assert.deepEqual(effAdmin, [], "pure admin → [] bypass");

  // A multi-role user that merely INCLUDES admin also bypasses.
  const effMulti = computeEffectivePermissions({
    role: "support",
    roles: ["support", "admin"],
    customRoleTokens: [],
    override: { grants: [], revokes: [] },
    baselines: newBaselines,
  });
  assert.deepEqual(effMulti, [], "support+admin → [] bypass");
});

// ── 8. Multi-role member: editing ONE role updates only that role's slice ─────
test("editing a built-in role: a support+pack_creator user gets the union with only support changed", () => {
  // OLD: both code baselines. NEW: support gains /analytics; pack_creator same.
  const oldBaselines: BaselineMap = {
    support: [...SUPPORT],
    pack_creator: [...PACK],
  };
  const newSupport = [...SUPPORT, "/analytics"];
  const newBaselines: BaselineMap = {
    support: newSupport,
    pack_creator: [...PACK],
  };

  // No manual adjustments → effective is the union of both baselines.
  const state: PermissionStateCore = {
    role: "support",
    roles: ["support", "pack_creator"],
    customRoleTokens: [],
    allowedPages: [...new Set([...SUPPORT, ...PACK])],
    override: { grants: [], revokes: [] },
  };

  const out = rematerializeForBuiltInEdit(state, oldBaselines, newBaselines);
  const expected = [...new Set([...newSupport, ...PACK])];
  assert.ok(setEq(out, expected), "union(newSupport, pack) — only support slice changed");
  assert.ok(out.includes("/analytics"), "support's new token applied");
  // pack_creator slice intact.
  assert.ok(out.includes("__can_create_pack"), "pack_creator slice unchanged");
});

// ── 9. The derive-vs-materialize SPLIT matters (deriving against new = bug) ────
test("editing a built-in role: deriving against the OLD baseline is required (not the new one)", () => {
  // OLD support baseline INCLUDES /chat; NEW support baseline DROPS /chat.
  const oldBaselines: BaselineMap = { support: [...SUPPORT] };
  const newSupport = SUPPORT.filter((t) => t !== "/chat");
  const newBaselines: BaselineMap = { support: [...newSupport] };

  // Never-edited user: allowed_pages == OLD baseline exactly (so they have NO
  // manual adjustments). The correct result is the NEW baseline verbatim.
  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: [...SUPPORT],
    override: { grants: [], revokes: [] },
  };

  // CORRECT path: derive vs OLD, materialize vs NEW.
  const correct = rematerializeForBuiltInEdit(state, oldBaselines, newBaselines);
  assert.ok(setEq(correct, newSupport), "correct: adopts new baseline, /chat dropped");
  assert.ok(!correct.includes("/chat"), "correct: /chat removed by the edit");

  // BUGGY path (deriving vs the NEW map): would treat /chat as a manual grant
  // and re-add it, freezing the user on the OLD set. Assert the correct path
  // does NOT match the buggy outcome.
  const buggyOverride = effectiveOverrideFor(state, newBaselines);
  const buggy = materializeForOverride(state, buggyOverride, newBaselines);
  assert.ok(buggy.includes("/chat"), "buggy path would wrongly retain /chat");
  assert.ok(
    !setEq(correct, buggy),
    "correct (derive-vs-old) differs from buggy (derive-vs-new)",
  );
});

// ── 10. No baseline map for the role → falls back to code baseline ───────────
test("editing a built-in role: an absent map entry falls back to the code baseline", () => {
  // If a NEW map somehow omits the role, the materializer falls back to the
  // code ROLE_BASELINES for it (least surprise). Proven directly.
  const eff = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override: { grants: [], revokes: [] },
    baselines: {}, // empty map
  });
  assert.ok(setEq(eff, SUPPORT), "empty map → code support baseline");

  // And `baselineUnionFor` honors a provided override entry over code.
  const union = baselineUnionFor(["support"], [], { support: ["/only-this"] });
  assert.ok(setEq(union, ["/only-this"]), "provided map entry overrides code baseline");
});

// ── 11. RENAME / LANDING edit (RoleV2 P3/P4) is access-neutral ───────────────
// `updateBuiltInRole` can now also write a DISPLAY name + a landing_route. Those
// are PURELY cosmetic/routing — identity stays `system_key`/enum and the
// materializer reads only `capabilities`. So a name/landing-only edit (caps
// UNCHANGED) must leave every holder's effective set byte-identical. Proven by
// re-materializing with the SAME baseline map on both sides (caps unchanged).
test("editing a built-in role: a name/landing-only change leaves effective access identical", () => {
  // Caps are the SAME on both sides — only the (un-modelled here) name/landing
  // differ in the real action. The materializer ignores them, so old == new.
  const baselines: BaselineMap = { support: [...SUPPORT] };

  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: [...SUPPORT, "/analytics"], // a manual grant on top
    override: { grants: [], revokes: [] },
  };

  // "Before" and "after" a rename/landing edit use the identical baseline map.
  const before = rematerializeForBuiltInEdit(state, baselines, baselines);
  const after = rematerializeForBuiltInEdit(state, baselines, baselines);
  assert.ok(setEq(before, after), "rename/landing edit must not change effective access");
  // And it equals the plain materialization (baseline ∪ grant).
  const expected = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override: { grants: ["/analytics"], revokes: [] },
    baselines,
  });
  assert.ok(setEq(after, expected), "effective == baseline ∪ {grant} (caps unchanged)");
});
