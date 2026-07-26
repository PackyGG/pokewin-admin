// =============================================================================
// Phase C materializer + override unit tests (NO DB).
//
// Proves the canonical write-path logic that the per-user editor and the
// role-change / custom-role actions rely on, using the REAL pure helpers:
//   • computeEffectivePermissions  (src/lib/permissions/materialize.ts)
//   • the override math            (src/lib/permissions/override.ts)
// The server-only DB glue (loadUserPermissionState in write-paths.ts) is NOT
// imported here — it can't load in a plain tsx/node:test context (imports
// adminDb / server-only). Its only logic beyond a DB read is delegating to
// these pure functions, which are exercised directly below.
//
// Run via tsx (wired into package.json `test:parity`):
//   npx tsx --test scripts/__fixtures__/override-materializer.test.ts
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeEffectivePermissions } from "@/lib/permissions/materialize";
import {
  baselineUnionFor,
  deriveOverrideFromAllowedPages,
  effectiveOverrideFor,
  rematerializeForRoleChange,
  materializeForOverride,
  type PermissionStateCore,
} from "@/lib/permissions/override";
import { ROLE_BASELINES } from "@/lib/role-baselines";

const setEq = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
};

const SUPPORT = ROLE_BASELINES.support.tokens;
const PACK = ROLE_BASELINES.pack_creator.tokens;

// ── 1. Empty override → effective == baseline ────────────────────────────────
test("empty override materializes to exactly the role baseline", () => {
  const eff = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override: { grants: [], revokes: [] },
  });
  assert.ok(setEq(eff, SUPPORT), "support + no override == support baseline");
});

// ── 2. Grant adds a token on top of the baseline ─────────────────────────────
test("a grant adds a non-baseline token to the effective set", () => {
  const eff = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override: { grants: ["/packs"], revokes: [] },
  });
  assert.ok(eff.includes("/packs"), "granted /packs present");
  assert.ok(setEq(eff, [...SUPPORT, "/packs"]), "baseline ∪ {/packs}");
});

// ── 3. Revoke wins over the baseline for the same token ──────────────────────
test("a revoke removes a baseline token (revoke wins)", () => {
  const eff = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override: { grants: [], revokes: ["/chat"] },
  });
  assert.ok(!eff.includes("/chat"), "revoked /chat absent");
  assert.ok(
    setEq(eff, SUPPORT.filter((t) => t !== "/chat")),
    "baseline \\ {/chat}",
  );
});

test("sticky role tokens survive explicit revokes without a page-load write", () => {
  const support = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override: { grants: [], revokes: ["/users", "/dashboard"] },
  });
  assert.ok(support.includes("/users"), "support keeps /users");
  assert.ok(support.includes("/dashboard"), "support keeps /dashboard");

  const packCreator = computeEffectivePermissions({
    role: "pack_creator",
    roles: ["pack_creator"],
    customRoleTokens: [],
    override: {
      grants: [],
      revokes: [...ROLE_BASELINES.pack_creator.tokens],
    },
  });
  assert.ok(
    setEq(packCreator, ROLE_BASELINES.pack_creator.tokens),
    "pack_creator keeps its full sticky contract",
  );
});

test("sticky invariants survive a stale editable baseline", () => {
  const eff = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override: { grants: [], revokes: ["/users", "/dashboard"] },
    baselines: { support: ["/chat"] },
  });
  assert.ok(setEq(eff, ["/chat", "/users", "/dashboard"]));
});

// ── 4. Revoke beats a same-token grant (order: grants then revokes) ──────────
test("a revoke beats a grant for the same token", () => {
  const eff = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override: { grants: ["/packs"], revokes: ["/packs"] },
  });
  assert.ok(!eff.includes("/packs"), "revoke wins over grant");
});

// ── 5. admin → total bypass ([]) regardless of override ──────────────────────
test("admin role materializes to [] (gate bypass) even with grants", () => {
  const eff = computeEffectivePermissions({
    role: "admin",
    roles: ["admin"],
    customRoleTokens: [],
    override: { grants: ["/packs", "/users"], revokes: [] },
  });
  assert.deepEqual(eff, [], "admin bypass returns []");

  // Even a multi-role set that merely INCLUDES admin bypasses.
  const eff2 = computeEffectivePermissions({
    role: "support",
    roles: ["support", "admin"],
    customRoleTokens: [],
    override: { grants: [], revokes: [] },
  });
  assert.deepEqual(eff2, [], "support+admin bypasses too");
});

// ── 6. deriveOverrideFromAllowedPages reconstructs grants/revokes exactly ─────
test("deriveOverrideFromAllowedPages round-trips an arbitrary allowed set", () => {
  const baseline = baselineUnionFor(["support"], []);
  // A support user who was manually granted /packs and had /chat revoked.
  const allowed = [...SUPPORT.filter((t) => t !== "/chat"), "/packs"];
  const override = deriveOverrideFromAllowedPages(allowed, baseline);
  assert.ok(setEq(override.grants, ["/packs"]), "grants = allowed \\ baseline");
  assert.ok(setEq(override.revokes, ["/chat"]), "revokes = baseline \\ allowed");

  // Re-materializing with the derived override reproduces `allowed` exactly.
  const eff = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override,
  });
  assert.ok(setEq(eff, allowed), "derived override reproduces allowed_pages");
});

// ── 7. Value token (e.g. balance limit) survives as a grant ──────────────────
test("a value token round-trips as a grant", () => {
  const baseline = baselineUnionFor(["support"], []);
  const allowed = [...SUPPORT, "__balance_limit_daily:10"];
  const override = deriveOverrideFromAllowedPages(allowed, baseline);
  assert.ok(
    override.grants.includes("__balance_limit_daily:10"),
    "value token in grants",
  );
  const eff = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    override,
  });
  assert.ok(
    eff.includes("__balance_limit_daily:10"),
    "value token preserved through the materializer",
  );
});

// ── 8. effectiveOverrideFor: explicit override wins, else derived ────────────
test("effectiveOverrideFor uses explicit override when present, else derives", () => {
  const baseline = baselineUnionFor(["support"], []);

  // Never-edited user (empty override) → derived from allowed_pages vs baseline.
  const derivedState: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: [...SUPPORT, "/packs"],
    override: { grants: [], revokes: [] },
  };
  const derived = effectiveOverrideFor(derivedState);
  assert.ok(setEq(derived.grants, ["/packs"]), "derived grants from allowed");
  assert.ok(setEq(derived.revokes, []), "derived no revokes");
  void baseline;

  // Already-edited user (explicit override) → used verbatim, NOT re-derived.
  const explicitState: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    // allowedPages intentionally stale/different to prove it's ignored here.
    allowedPages: SUPPORT,
    override: { grants: ["/cards"], revokes: ["/chat"] },
  };
  const explicit = effectiveOverrideFor(explicitState);
  assert.ok(setEq(explicit.grants, ["/cards"]), "explicit grants used verbatim");
  assert.ok(setEq(explicit.revokes, ["/chat"]), "explicit revokes used verbatim");
});

// ── 9. Role change preserves a never-edited user's manual adjustments ─────────
test("rematerializeForRoleChange keeps manual adjustments across a role switch", () => {
  // A support user manually granted /packs and revoked /shifts, override cols
  // still empty (the pre-edit state).
  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: [...SUPPORT.filter((t) => t !== "/shifts"), "/packs"],
    override: { grants: [], revokes: [] },
  };

  // Switch to support + pack_creator. The new baseline is SUPPORT ∪ PACK.
  const { allowedPages } = rematerializeForRoleChange(
    state,
    ["support", "pack_creator"],
    [],
  );

  // /packs was a manual grant — now also in the pack_creator baseline → present.
  assert.ok(allowedPages.includes("/packs"), "/packs present after switch");
  // /shifts was manually revoked from the support baseline → still absent.
  assert.ok(!allowedPages.includes("/shifts"), "manual revoke survives switch");
  // The new pack_creator baseline tokens are now granted.
  assert.ok(allowedPages.includes("/cards"), "new role baseline applied");
  assert.ok(allowedPages.includes("__can_create_pack"), "new role caps applied");
  // Expected: (SUPPORT ∪ PACK) with /shifts revoked.
  const expected = [...new Set([...SUPPORT, ...PACK])].filter(
    (t) => t !== "/shifts",
  );
  assert.ok(setEq(allowedPages, expected), "exact behavior-preserving merge");
});

// ── 10. Role change → admin yields [] (bypass) ───────────────────────────────
test("rematerializeForRoleChange to admin returns [] (gate bypass)", () => {
  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: SUPPORT,
    override: { grants: [], revokes: [] },
  };
  const { allowedPages } = rematerializeForRoleChange(state, ["admin"], []);
  assert.deepEqual(allowedPages, [], "admin → [] bypass");
});

// ── 11. Custom-role tokens count as baseline (Layer 2) ───────────────────────
test("custom-role tokens are part of the baseline union", () => {
  const customTokens = ["/analytics", "__can_export_users"];
  const baseline = baselineUnionFor(["support"], customTokens);
  assert.ok(baseline.includes("/analytics"), "custom token in baseline");

  // A user on support + this custom role, no override → effective == union.
  const eff = computeEffectivePermissions({
    role: "support",
    roles: ["support"],
    customRoleTokens: customTokens,
    override: { grants: [], revokes: [] },
  });
  assert.ok(setEq(eff, [...new Set([...SUPPORT, ...customTokens])]));
});

// ── 12. materializeForOverride = editor save path (explicit override) ─────────
test("materializeForOverride applies the editor's explicit override", () => {
  const state: PermissionStateCore = {
    role: "support",
    roles: ["support"],
    customRoleTokens: [],
    allowedPages: SUPPORT,
    override: { grants: [], revokes: [] },
  };
  const out = materializeForOverride(state, {
    grants: ["/packs"],
    revokes: ["/chat"],
  });
  assert.ok(out.includes("/packs"), "explicit grant applied");
  assert.ok(!out.includes("/chat"), "explicit revoke applied");
  assert.ok(
    setEq(out, [...SUPPORT.filter((t) => t !== "/chat"), "/packs"]),
    "baseline ∪ grants \\ revokes",
  );
});
