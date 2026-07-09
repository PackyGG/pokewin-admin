#!/usr/bin/env node
// =============================================================================
// limits-parity-harness.mjs — READ-ONLY enforcement-resolution proof for the
// per-ROLE balance-limit defaults (RoleV2 P3/P4). Sibling of
// permission-parity-harness.mjs; same probe mechanics.
//
// CONTRACT HISTORY: at P3-ship time this asserted the role-default layer was
// INERT (every role limit column NULL → merged cap == per-user-or-unlimited).
// That was a point-in-time SHIPPING gate. P4 then shipped the role-limits
// editor (`setRoleLimits`), so owner-set role caps are now legitimate LIVE
// config the runtime enforces (e.g. support weekly $500) — "a role column is
// non-null" stopped being a defect. The gate below therefore asserts the
// DURABLE layering invariants instead of inertness.
//
// What it does:
//   1. Re-probes the ADMIN DB READ-ONLY (writes a throwaway
//      _probe-limits-parity.mjs, runs it with `node --env-file=.env`, connects
//      ONLY to process.env.ADMIN_DATABASE_URL via `pg`, SELECT-only, never
//      selects or prints password_hash / totp_secret / recovery_codes / the
//      connection string; the probe is deleted afterwards).
//   2. For EVERY admin_user, per period (daily/weekly/monthly), resolves the
//      effective cap exactly as the runtime does —
//        effective = userRow[period]?.max ?? roleDefault[period] ?? null
//      — and asserts the layering invariants:
//        • PER-USER WINS: a non-null per-user row is never overridden by a
//          role default (effective === userMax whenever userMax != null).
//        • SANE CAPS: every non-null cap (user or role) is a positive finite
//          number.
//   3. Prints the per-admin, per-period resolution with the SOURCE of each
//      cap (user / role / ∞), loudly lists every ACTIVE role default (so
//      enforcement-changing config is visible in the log), and exits NON-ZERO
//      only on an invariant violation or probe failure.
//
// `roleDefault[period]` is computed here exactly as the runtime does
// (src/lib/role-limits.ts → mergeRoleBalanceLimits): the SMALLEST non-null
// balance_limit_{period} across the admin's effective built-in roles (matched
// by admin_roles.system_key) PLUS any custom role (matched by role_id).
//
// Run:  node --env-file=.env scripts/limits-parity-harness.mjs
//
// Self-contained (no TS imports) so it runs under a plain `node --env-file`.
// The committed unit test (scripts/__fixtures__/role-limits-merge.test.ts)
// exercises the REAL mergeRoleBalanceLimits / resolveEffectiveCap from
// src/lib/role-limits-merge.ts, so this port can't silently mean something
// different from the runtime.
// =============================================================================

import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ── Recognized built-in roles (mirror of admin_role enum / ALL_ADMIN_ROLES) ──
const KNOWN_ROLES = new Set([
  "admin",
  "support",
  "marketing",
  "creator",
  "pack_creator",
  "creator_manager",
]);

// In-memory mirror of getEffectiveRoles (src/lib/admin-roles.ts): dedupe the
// primary `role` + the `roles` array, keep only recognized built-in roles, and
// guarantee the primary role is present first.
function effectiveRoles(role, roles) {
  const set = new Set();
  if (KNOWN_ROLES.has(role)) set.add(role);
  for (const r of roles ?? []) if (KNOWN_ROLES.has(r)) set.add(r);
  return [...set];
}

const PERIODS = ["daily", "weekly", "monthly"];

// Faithful port of mergeRoleBalanceLimits (src/lib/role-limits-merge.ts):
// smallest non-null value per period across the given role rows.
function mergeRoleBalanceLimits(rows) {
  const out = { daily: null, weekly: null, monthly: null };
  for (const row of rows) {
    for (const p of PERIODS) {
      const v = row[p];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (out[p] === null || v < out[p]) out[p] = v;
    }
  }
  return out;
}

// Faithful port of resolveEffectiveCap: userMax ?? roleDefault ?? null.
function resolveEffectiveCap(userMax, roleDefault) {
  return userMax ?? roleDefault ?? null;
}

// ── Probe the ADMIN DB read-only via a throwaway script ──────────────────────
const PROBE_PATH = path.join(repoRoot, "_probe-limits-parity.mjs");

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
// Admins (role/roles/role_id only — never any secret column).
const users = await client.query(
  \`SELECT id, username, role,
          array_to_json(roles)::jsonb AS roles, role_id
     FROM admin_users
    ORDER BY created_at ASC NULLS LAST, id ASC\`,
);
// All role rows + their balance-limit columns (built-ins keyed by system_key,
// custom rows by id). Decimal → ::float8 so it arrives as a JS number|null.
const roles = await client.query(
  \`SELECT id, system_key, name,
          balance_limit_daily::float8   AS daily,
          balance_limit_weekly::float8  AS weekly,
          balance_limit_monthly::float8 AS monthly
     FROM admin_roles\`,
);
// Per-user balance caps.
const limits = await client.query(
  \`SELECT admin_user_id, period_type, max_amount::float8 AS max_amount
     FROM admin_balance_limits\`,
);
await client.end();
const out = {
  meta: {
    userCount: users.rowCount,
    roleCount: roles.rowCount,
    userLimitCount: limits.rowCount,
    probedAt: new Date().toISOString(),
  },
  users: users.rows.map((r) => ({
    id: r.id, username: r.username, role: r.role,
    roles: r.roles ?? [], roleId: r.role_id ?? null,
  })),
  roles: roles.rows.map((r) => ({
    id: r.id, systemKey: r.system_key ?? null, name: r.name,
    daily: r.daily, weekly: r.weekly, monthly: r.monthly,
  })),
  userLimits: limits.rows.map((r) => ({
    adminUserId: r.admin_user_id, period: r.period_type, max: r.max_amount,
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
    try {
      return JSON.parse(res.stdout);
    } catch {
      throw new Error(`probe produced non-JSON output: ${res.stdout.slice(0, 200)}`);
    }
  } finally {
    if (existsSync(PROBE_PATH)) rmSync(PROBE_PATH, { force: true });
  }
}

// Compute one admin's merged role-default caps from the probed role rows.
function roleDefaultsFor(user, rolesById, rolesBySystemKey) {
  const eff = effectiveRoles(user.role, user.roles);
  const applicable = [];
  for (const key of eff) {
    const row = rolesBySystemKey.get(key);
    if (row) applicable.push(row);
  }
  if (user.roleId) {
    const custom = rolesById.get(user.roleId);
    if (custom) applicable.push(custom);
  }
  return mergeRoleBalanceLimits(applicable);
}

function main() {
  console.log("[limits-parity] probing ADMIN DB (read-only)…");
  const snap = probeAdminDb();

  const rolesById = new Map(snap.roles.map((r) => [r.id, r]));
  const rolesBySystemKey = new Map();
  for (const r of snap.roles) if (r.systemKey) rolesBySystemKey.set(r.systemKey, r);

  // Per-user caps keyed "userId|period" → max.
  const userCap = new Map();
  for (const l of snap.userLimits) userCap.set(`${l.adminUserId}|${l.period}`, l.max);

  // List every ACTIVE role default up front — owner-set config the runtime
  // enforces for admins without a per-user row. Informational, not a failure.
  const activeRoleCaps = [];
  for (const r of snap.roles) {
    for (const p of PERIODS) {
      if (r[p] !== null && r[p] !== undefined) {
        activeRoleCaps.push(`${r.systemKey ?? r.name}.${p}=${fmt(r[p])}`);
      }
    }
  }
  console.log(
    `[limits-parity] ${snap.meta.userCount} admins · ${snap.meta.roleCount} roles · ` +
      `${snap.meta.userLimitCount} per-user caps · active role default columns: ${activeRoleCaps.length}` +
      (activeRoleCaps.length ? ` → ${activeRoleCaps.join(", ")}` : ""),
  );

  console.log("\n[limits-parity] per-admin, per-period resolution (userRow ?? roleDefault ?? ∞):\n");
  let violations = 0;
  let checks = 0;

  for (const u of snap.users) {
    const roleDef = roleDefaultsFor(u, rolesById, rolesBySystemKey);
    const eff = effectiveRoles(u.role, u.roles);
    const parts = [];
    let userRowParts = [];
    let userViolations = 0;

    for (const p of PERIODS) {
      const userMax = userCap.has(`${u.id}|${p}`) ? userCap.get(`${u.id}|${p}`) : undefined;
      const effective = resolveEffectiveCap(userMax, roleDef[p]);
      const source = userMax != null ? "user" : roleDef[p] != null ? "role" : "∞";
      checks++;

      // Invariant 1 — PER-USER WINS: a non-null per-user row is the cap.
      const userWins = userMax == null || effective === userMax;
      // Invariant 2 — SANE CAPS: any non-null cap is a positive finite number.
      const sane = effective === null || (Number.isFinite(effective) && effective > 0);
      const ok = userWins && sane;
      if (!ok) {
        violations++;
        userViolations++;
      }
      const tag = ok ? "ok" : !userWins ? "USER-ROW-OVERRIDDEN" : "BAD-CAP";
      parts.push(`${p}=${fmt(effective)}[${source}] ${tag}`);
      if (userMax !== undefined) userRowParts.push(`${p}:${fmt(userMax)}`);
    }

    const tag = userViolations === 0 ? "PASS" : "FAIL";
    const roleStr = eff.length ? eff.join("+") : u.role;
    const customStr = u.roleId ? ` +custom(${u.roleId.slice(0, 8)})` : "";
    const userRowStr = userRowParts.length ? `userRow{${userRowParts.join(",")}}` : "userRow{—}";
    console.log(
      `  [${tag}] ${String(u.username).padEnd(16)} ${roleStr}${customStr}  ${userRowStr}  ${parts.join("  ")}`,
    );
  }

  console.log("");
  if (violations === 0) {
    console.log(
      `✅ all ${snap.meta.userCount} admins resolve cleanly across ${checks} (admin × period) checks — ` +
        `per-user rows always win, every cap is a positive finite number. ` +
        (activeRoleCaps.length
          ? `${activeRoleCaps.length} active role default(s) in force (listed above) for admins without a per-user row — owner-set config, enforced by checkBalanceAdjustmentLimit.`
          : `No active role defaults; every admin without a per-user row is unlimited.`),
    );
    process.exit(0);
  } else {
    console.error(
      `❌ ${violations} of ${checks} (admin × period) checks VIOLATE the layering invariants ` +
        `(per-user row overridden by a role default, or a non-positive/non-finite cap). ` +
        `The runtime resolution (userRow ?? roleDefault ?? unlimited) is broken — investigate before shipping.`,
    );
    process.exit(1);
  }
}

function fmt(v) {
  return v === null || v === undefined ? "∞" : `$${Number(v).toFixed(2)}`;
}

// Only probe when run directly. When imported, do nothing (no DB access).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
