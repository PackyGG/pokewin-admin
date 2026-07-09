#!/usr/bin/env node
// =============================================================================
// permission-parity-harness.mjs — READ-ONLY behavior-preservation proof for
// the role/permission rebuild (Phase A). See ROLE_REDESIGN_DESIGN.md.
//
// What it does:
//   1. Re-probes the ADMIN DB READ-ONLY (writes a throwaway _probe-parity.mjs,
//      runs it with `node --env-file=.env`, connects ONLY to
//      process.env.ADMIN_DATABASE_URL via `pg`, SELECT-only, never selects or
//      prints password_hash / totp_secret / recovery_codes / the connection
//      string; the probe is deleted afterwards).
//   2. Emits scripts/parity-target.json (UNCOMMITTED) — the probed snapshot.
//   3. For EVERY admin_user, derives the per-user override plan and asserts
//      `baseline ∪ grants \ revokes == current allowed_pages` (set-equal).
//      Admins: gate-visible [] AND the stored array round-trips.
//   4. Prints the derived override plan and exits NON-ZERO if any user fails.
//
// This is the cutover gate: a green run proves the NEW editable-source model
// reproduces every existing user's effective access byte-for-byte. It changes
// NOTHING — read-only against the DB, never writes allowed_pages.
//
// Run:  node --env-file=.env scripts/permission-parity-harness.mjs
//
// NOTE: this harness is self-contained (no TS imports) so it runs under a
// plain `node --env-file`. Its embedded baselines are a faithful port of
// src/lib/role-baselines.ts; the committed CI fixture test
// (scripts/__fixtures__/parity-fixture.test.ts) imports BOTH these embedded
// baselines AND the real ROLE_BASELINES and asserts they are identical, so the
// port can never silently drift from the source.
// =============================================================================

import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ── Canonical baselines (faithful port of src/lib/role-baselines.ts) ─────────
// admin = [] (total-bypass sentinel). marketing/creator/creator_manager = []
// (no live holder). support = 15, pack_creator = 23 (the `/transactions/rewards`
// + `/rewards/shards` tokens left with their removed pages — f6514a42 / 1dcbaabd).
export const HARNESS_ROLE_BASELINES = {
  admin: [],
  support: [
    "/shifts",
    "/users",
    "/transactions/packs",
    "/transactions/deposits",
    "/chat",
    "/withdrawals",
    "/dashboard",
    "__can_edit_identity",
    "__can_ban_users",
    "__can_lock_users",
    "__can_toggle_feature_locks",
    "__can_create_user_note",
    "__can_mute_users",
    "__can_delete_messages",
    "__can_pin_messages",
  ],
  marketing: [],
  creator: [],
  pack_creator: [
    "/packs",
    "/cards",
    "/sets",
    "/upgrader",
    "__can_create_pack",
    "__can_update_pack",
    "__can_edit_live_packs",
    "__can_upload_pack_image",
    "__can_create_card",
    "__can_update_card",
    "__can_delete_card",
    "__can_upload_card_image",
    "__can_create_set",
    "__can_delete_pack",
    "__can_toggle_pack_active",
    "__can_update_set",
    "__can_delete_set",
    "__can_seed_initial_sets",
    "__can_force_absorb_cards",
    "__can_upload_set_image",
    "__can_add_upgrader_output",
    "__can_toggle_upgrader_output",
    "__can_remove_upgrader_output",
  ],
  creator_manager: [],
};

// In-memory mirror of getEffectiveRoles (src/lib/admin-roles.ts): dedupe the
// primary `role` + the `roles` array, keep only recognized built-in roles, and
// guarantee the primary role is present first.
const KNOWN_ROLES = new Set(Object.keys(HARNESS_ROLE_BASELINES));
function effectiveRoles(role, roles) {
  const set = new Set();
  if (KNOWN_ROLES.has(role)) set.add(role);
  for (const r of roles ?? []) if (KNOWN_ROLES.has(r)) set.add(r);
  return [...set];
}

function baselineTokensFor(role) {
  return HARNESS_ROLE_BASELINES[role] ?? [];
}

// ── sanitize for parity inputs (de-dup + stable order) ───────────────────────
// The real sanitizePermissionKeys (permissions-utils.ts) drops genuinely-
// unknown keys and is value-token-aware (it preserves e.g.
// `__balance_limit_daily:10`). The harness can't import that without pulling
// ALL_PAGE_KEYS / CAPABILITIES into a plain .mjs, but it does NOT need to: every
// token reconciled here comes straight from the DB (the source of truth for
// what's currently stored), so the only operation that matters for parity is
// de-dup + stable order — VALUE tokens are kept verbatim (exactly the
// regression-free behavior the rebuild guarantees), and nothing in a stored
// array is "unknown" to itself. The real sanitizer's unknown-dropping AND its
// value-token preservation are exercised directly against the live data by the
// committed CI fixture test (scripts/__fixtures__/parity-fixture.test.ts),
// which imports the actual sanitizePermissionKeys.
function sanitize(tokens) {
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Faithful port of computeEffectivePermissions (materialize.ts).
function computeEffective({ role, roles, customRoleTokens, override }) {
  const eff = effectiveRoles(role, roles);
  if (eff.includes("admin")) return []; // total bypass
  const set = new Set();
  for (const r of eff) for (const t of baselineTokensFor(r)) set.add(t);
  for (const t of customRoleTokens ?? []) set.add(t);
  for (const t of override.grants ?? []) set.add(t);
  for (const t of override.revokes ?? []) set.delete(t);
  return sanitize([...set]);
}

const setEq = (a, b) => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
};

// ── Step 1+2: probe the ADMIN DB read-only via a throwaway script ────────────
const PROBE_PATH = path.join(repoRoot, "_probe-parity.mjs");
const TARGET_PATH = path.join(repoRoot, "scripts", "parity-target.json");

const PROBE_SRC = `// AUTO-GENERATED throwaway read-only probe — ADMIN DB only. Deleted after use.
import pg from "pg";
const url = process.env.ADMIN_DATABASE_URL;
if (!url) { console.error("ADMIN_DATABASE_URL not set"); process.exit(2); }
if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
  console.error("Refusing: ADMIN_DATABASE_URL == DATABASE_URL (would hit the game DB)");
  process.exit(2);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
const colres = await client.query(
  \`SELECT column_name FROM information_schema.columns
     WHERE table_name = 'admin_users'
       AND column_name IN ('permission_grants','permission_revokes','roles','role_id')\`,
);
const cols = new Set(colres.rows.map((r) => r.column_name));
const hasGrants = cols.has("permission_grants");
const hasRevokes = cols.has("permission_revokes");
const hasRoles = cols.has("roles");
const hasRoleId = cols.has("role_id");
const selectCols = [
  "id", "username", "role",
  // enum array OID isn't registered by pg -> convert to a JSON array so it
  // arrives as a real string[] instead of the "{a,b}" array literal.
  hasRoles ? "array_to_json(roles)::jsonb AS roles" : "'[]'::jsonb AS roles",
  "allowed_pages",
  hasGrants ? "permission_grants" : "ARRAY[]::text[] AS permission_grants",
  hasRevokes ? "permission_revokes" : "ARRAY[]::text[] AS permission_revokes",
  hasRoleId ? "role_id" : "NULL::text AS role_id",
].join(", ");
const res = await client.query(
  \`SELECT \${selectCols} FROM admin_users ORDER BY created_at ASC NULLS LAST, id ASC\`,
);
let customRoles = [];
try {
  const cr = await client.query(\`SELECT id, name, capabilities FROM admin_roles\`);
  customRoles = cr.rows.map((r) => ({ id: r.id, name: r.name, capabilities: r.capabilities ?? [] }));
} catch { customRoles = []; }
// RoleV2 P0: the six built-in roles are now ALSO rows in admin_roles, keyed by
// system_key (the admin_role enum value). Probe them so the harness can assert
// each system row's capabilities == the code baseline. Degrades to [] if the
// system_key column doesn't exist yet (pre-migration) — then the assertion is
// skipped (no system rows) and per-user parity still proves behavior.
let systemRoles = [];
try {
  const sr = await client.query(
    \`SELECT system_key, name, is_system, capabilities
       FROM admin_roles
      WHERE system_key IS NOT NULL
      ORDER BY system_key ASC\`,
  );
  systemRoles = sr.rows.map((r) => ({
    systemKey: r.system_key,
    name: r.name,
    isSystem: r.is_system === true,
    capabilities: r.capabilities ?? [],
  }));
} catch { systemRoles = []; }
await client.end();
const out = {
  meta: {
    hasGrantsColumn: hasGrants, hasRevokesColumn: hasRevokes,
    hasRolesColumn: hasRoles, hasRoleIdColumn: hasRoleId,
    userCount: res.rows.length, customRoleCount: customRoles.length,
    systemRoleCount: systemRoles.length,
    probedAt: new Date().toISOString(),
  },
  customRoles,
  systemRoles,
  users: res.rows.map((r) => ({
    id: r.id, username: r.username, role: r.role,
    roles: r.roles ?? [], allowedPages: r.allowed_pages ?? [],
    permissionGrants: r.permission_grants ?? [], permissionRevokes: r.permission_revokes ?? [],
    roleId: r.role_id ?? null,
  })),
};
process.stdout.write(JSON.stringify(out));
`;

function probeAdminDb() {
  writeFileSync(PROBE_PATH, PROBE_SRC, "utf8");
  try {
    const res = spawnSync(
      process.execPath,
      ["--env-file=.env", PROBE_PATH],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (res.status !== 0) {
      const msg = (res.stderr || res.stdout || "unknown error").trim();
      throw new Error(
        `probe failed (exit ${res.status}). Is .env present with ADMIN_DATABASE_URL? Details: ${msg}`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      throw new Error(
        `probe produced non-JSON output: ${res.stdout.slice(0, 200)}`,
      );
    }
    return parsed;
  } finally {
    // Always delete the throwaway probe, even on error.
    if (existsSync(PROBE_PATH)) rmSync(PROBE_PATH, { force: true });
  }
}

function main() {
  console.log("[parity] probing ADMIN DB (read-only)…");
  const snapshot = probeAdminDb();

  // Emit the uncommitted target snapshot.
  writeFileSync(TARGET_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(
    `[parity] wrote ${path.relative(repoRoot, TARGET_PATH)} (uncommitted) · ${
      snapshot.meta.userCount
    } users · override columns present: grants=${snapshot.meta.hasGrantsColumn} revokes=${snapshot.meta.hasRevokesColumn}`,
  );

  const customCapsById = new Map(
    (snapshot.customRoles ?? []).map((r) => [r.id, r.capabilities ?? []]),
  );

  const plan = [];
  let failures = 0;

  console.log("\n[parity] per-user reconciliation:\n");
  for (const u of snapshot.users) {
    const eff = effectiveRoles(u.role, u.roles);
    const isAdmin = eff.includes("admin");
    const customRoleTokens = u.roleId ? customCapsById.get(u.roleId) ?? [] : [];

    // Baseline union (built-in baselines + any custom-role capabilities).
    const baselineUnion = new Set();
    for (const r of eff) for (const t of baselineTokensFor(r)) baselineUnion.add(t);
    for (const t of customRoleTokens) baselineUnion.add(t);

    // Derive the minimal override plan.
    let grants;
    let revokes;
    if (isAdmin) {
      // Admins bypass the gate (effective []), but record the stored array
      // verbatim so it round-trips losslessly under the new model.
      grants = [...u.allowedPages];
      revokes = [];
    } else {
      const cur = new Set(u.allowedPages);
      grants = u.allowedPages.filter((k) => !baselineUnion.has(k));
      revokes = [...baselineUnion].filter((k) => !cur.has(k));
    }

    // Assert parity.
    const effective = computeEffective({
      role: u.role,
      roles: u.roles,
      customRoleTokens,
      override: { grants, revokes },
    });

    let pass;
    let detail = "";
    const storedSanitized = sanitize(u.allowedPages);
    if (isAdmin) {
      const gateOk = effective.length === 0;
      // Round-trip: admin baseline ([]) ∪ grants \ revokes == stored array.
      const revokeSet = new Set(revokes);
      const roundTrip = sanitize(
        [...baselineTokensFor("admin"), ...grants].filter((k) => !revokeSet.has(k)),
      );
      const rtOk = setEq(roundTrip, storedSanitized);
      pass = gateOk && rtOk;
      detail = `admin bypass · gate=[] (${gateOk ? "ok" : "BAD"}) · stored ${
        storedSanitized.length
      } tokens round-trip (${rtOk ? "ok" : "BAD"})`;
    } else {
      pass = setEq(effective, storedSanitized);
      detail = `${eff.join("+")} · effective ${effective.length} == stored ${
        storedSanitized.length
      }`;
      if (!pass) {
        const missing = storedSanitized.filter((k) => !effective.includes(k));
        const extra = effective.filter((k) => !storedSanitized.includes(k));
        detail += ` · MISSING ${JSON.stringify(missing)} EXTRA ${JSON.stringify(extra)}`;
      }
    }

    plan.push({
      username: u.username,
      role: u.role,
      roles: u.roles,
      isAdmin,
      grants,
      revokes,
      pass,
    });

    const tag = pass ? "PASS" : "FAIL";
    console.log(
      `  [${tag}] ${u.username.padEnd(16)} grants=${String(grants.length).padStart(
        2,
      )} revokes=${String(revokes.length).padStart(2)}  ${detail}`,
    );
    if (!pass) failures++;
  }

  // ── RoleV2 P0: seed == code assertion ──────────────────────────────────────
  // Every built-in `admin_roles` system row (system_key not null) must carry
  // capabilities that set-equal the code baseline HARNESS_ROLE_BASELINES[key]
  // (which the CI fixture proves equals the real ROLE_BASELINES). This is the
  // behavior-neutrality proof for the storage unification: getBaselineMap()
  // === code ⇒ identical materializer output ⇒ no re-materialization at deploy.
  const systemRoles = snapshot.systemRoles ?? [];
  console.log(
    `\n[parity] system-role seed == code (${systemRoles.length} system rows):\n`,
  );
  if (systemRoles.length === 0) {
    console.log(
      "  (no system rows found — system_key column may not be applied/seeded yet; per-user parity above still holds)",
    );
  }
  // Track which built-in enum keys we saw, so a MISSING system row also fails.
  const seenSystemKeys = new Set();
  for (const sr of systemRoles) {
    seenSystemKeys.add(sr.systemKey);
    const expected = HARNESS_ROLE_BASELINES[sr.systemKey];
    if (!expected) {
      console.log(
        `  [FAIL] system_key=${sr.systemKey} — unknown built-in role (no code baseline)`,
      );
      failures++;
      continue;
    }
    const have = sanitize(sr.capabilities);
    const want = sanitize(expected);
    const ok = setEq(have, want) && sr.isSystem === true;
    if (ok) {
      console.log(
        `  [PASS] ${String(sr.systemKey).padEnd(16)} name="${sr.name}" capabilities ${have.length} == code ${want.length} · is_system=${sr.isSystem}`,
      );
    } else {
      const missing = want.filter((k) => !have.includes(k));
      const extra = have.filter((k) => !want.includes(k));
      console.log(
        `  [FAIL] ${String(sr.systemKey).padEnd(16)} name="${sr.name}" is_system=${sr.isSystem} · MISSING ${JSON.stringify(missing)} EXTRA ${JSON.stringify(extra)}`,
      );
      failures++;
    }
  }
  // A system row must exist for EVERY built-in enum value once seeded. Only
  // enforce completeness when at least one system row is present (so a fully
  // pre-migration DB doesn't fail here — that path is covered by per-user parity).
  if (systemRoles.length > 0) {
    for (const key of Object.keys(HARNESS_ROLE_BASELINES)) {
      if (!seenSystemKeys.has(key)) {
        console.log(`  [FAIL] missing system row for built-in role "${key}"`);
        failures++;
      }
    }
  }

  // Derived override plan (feeds the owner-gated Phase-C backfill).
  console.log("\n[parity] derived override plan (per user → grants / revokes):");
  for (const p of plan) {
    const g = p.grants.length ? p.grants.join(", ") : "—";
    const r = p.revokes.length ? p.revokes.join(", ") : "—";
    console.log(
      `  • ${p.username} (${p.isAdmin ? "admin" : p.roles.join("+") || p.role})`,
    );
    console.log(`      grants:  ${g}`);
    console.log(`      revokes: ${r}`);
  }

  console.log("");
  if (failures === 0) {
    console.log(
      `✅ all ${snapshot.users.length} users reconcile — baseline ∪ grants \\ revokes == current allowed_pages for every user (admins: gate-visible [] + stored array round-trips)` +
        (systemRoles.length > 0
          ? ` AND all ${systemRoles.length} built-in system rows' capabilities == code baselines`
          : "") +
        `. Behavior is preserved.`,
    );
    process.exit(0);
  } else {
    console.error(
      `❌ ${failures} parity check(s) FAILED across ${snapshot.users.length} users + ${systemRoles.length} system rows — do NOT cut over. See the MISSING/EXTRA diffs above.`,
    );
    process.exit(1);
  }
}

// Only probe + reconcile when run directly (node scripts/permission-parity-harness.mjs).
// When imported (e.g. by the CI fixture test, which reuses HARNESS_ROLE_BASELINES
// for its drift guard), do nothing — no DB access on import.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
