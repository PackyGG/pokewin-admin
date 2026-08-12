import "server-only";

import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import {
  ALL_ADMIN_ROLES,
  getEffectiveRoles,
  type AdminRole,
} from "@/lib/admin-roles";
import { ROLE_BASELINES } from "@/lib/role-baselines";
import { computeEffectivePermissions } from "@/lib/permissions/materialize";
import { ADMIN_PAGES } from "@/lib/admin-pages";
import {
  CAPABILITIES,
  CAPABILITY_KEYS,
  sanitizePermissionKeys,
} from "@/app/(admin)/settings/roles/permissions-utils";

// ---------------------------------------------------------------------------
// Read-only data layer for the UNIFIED Roles surface.
//
// There is ONE concept: Role. The 6 enum roles (admin / support / marketing /
// creator / pack_creator / creator_manager) are the protected, undeletable
// backbone — still enum-wired underneath, identity = `system_key` — and live as
// `admin_roles` rows alongside the editable custom presets. This module emits a
// SINGLE merged role list (no "built-in vs custom" split) plus headline counts.
//
// Everything here is READ-ONLY against the ADMIN DB. The write paths live in
// the existing action files (custom-roles-actions.ts, built-in-roles-actions.ts,
// role-limits-actions.ts) and are untouched.
// ---------------------------------------------------------------------------

/** A single token rendered in the read-only baseline inspector. */
export type BaselineToken = {
  token: string;
  label: string;
  /** "page" route, "capability" flag, or a "value" token (e.g. a limit). */
  kind: "page" | "capability" | "value";
};

/** Baseline tokens grouped by their domain label, for the inspector. */
export type BaselineGroup = {
  group: string;
  tokens: BaselineToken[];
};

// Fast lookup maps from the canonical catalogs. Built once at module load.
const PAGE_BY_KEY = new Map(ADMIN_PAGES.map((p) => [p.key, p]));
const CAP_BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));

/**
 * Resolve one permission token to its display label + kind + group, using
 * the canonical ADMIN_PAGES / CAPABILITIES catalogs. Value tokens
 * (`<base>:<value>`, e.g. a balance limit) are labelled verbatim and grouped
 * under "Other". Unknown tokens fall back to the raw string under "Other".
 */
function describeToken(token: string): BaselineToken & { group: string } {
  const page = PAGE_BY_KEY.get(token);
  if (page) {
    return { token, label: page.label, kind: "page", group: page.group };
  }
  const cap = CAP_BY_KEY.get(token);
  if (cap) {
    return { token, label: cap.label, kind: "capability", group: cap.group };
  }
  if (token.includes(":")) {
    return { token, label: token, kind: "value", group: "Other" };
  }
  return { token, label: token, kind: "capability", group: "Other" };
}

/**
 * Group a baseline's tokens by their domain (page group / capability group).
 * Pages come first within each group, capabilities after. Group order
 * follows first appearance in ADMIN_PAGES then CAPABILITIES, so the inspector
 * reads in the same order as the rest of the admin.
 */
export function groupBaselineTokens(tokens: readonly string[]): BaselineGroup[] {
  const described = tokens.map(describeToken);
  const order: string[] = [];
  const byGroup = new Map<string, BaselineToken[]>();
  for (const d of described) {
    if (!byGroup.has(d.group)) {
      byGroup.set(d.group, []);
      order.push(d.group);
    }
    byGroup.get(d.group)!.push({ token: d.token, label: d.label, kind: d.kind });
  }
  return order.map((group) => ({
    group,
    // Pages first, then capabilities, then value tokens — stable + readable.
    tokens: byGroup.get(group)!.slice().sort((a, b) => {
      const rank = (k: BaselineToken["kind"]) =>
        k === "page" ? 0 : k === "capability" ? 1 : 2;
      return rank(a.kind) - rank(b.kind);
    }),
  }));
}

/**
 * ONE role, as shown on the unified grid. Covers both the 6 enum roles (system)
 * and the custom presets in a single shape — the UI never re-splits them.
 */
export type RoleSummary = {
  /**
   * The `admin_roles` row id. Used to deep-link into the editor at
   * `/admin-users/roles/[id]` and as the assignment `role_id`. `null` only if a
   * built-in system row is somehow missing post-migration (the grid then shows
   * the card without an editor link).
   */
  id: string | null;
  /** Stable React key: `system_key` for built-ins, `id` for custom rows. */
  key: string;
  /** Display name (editable for custom + the 5 non-admin system rows). */
  name: string;
  description: string | null;
  /** `true` for one of the 6 enum (system) roles — the protected backbone. */
  isSystem: boolean;
  /** The built-in enum key for a system row, else `null` (custom role). */
  systemKey: AdminRole | null;
  /** `admin` only — the one superuser role (total gate bypass). */
  isSuperuser: boolean;
  /** Page-route tokens in the role's capability set. */
  pageCount: number;
  /** `__can_*` capability tokens in the role's capability set. */
  capabilityCount: number;
  /** Total tokens (pages + capabilities + value tokens). */
  tokenCount: number;
  /** admin holders (built-in: effective-role holders; custom: role_id links). */
  holderCount: number;
  /** Per-role landing route override, or `null` (today's routing). */
  landingRoute: string | null;
  /** ISO timestamp of the role row's last update (custom rows show it). */
  updatedAt: string;
};

/** Everything the unified Roles surface renders. */
export type RolesOverview = {
  /** ONE merged list — the 6 system roles first (privilege order), then custom. */
  roles: RoleSummary[];
  kpis: {
    /** Total roles (system + custom). */
    roleCount: number;
    adminCount: number;
    /** Non-admin users whose effective set ≠ their role baseline set. */
    overrideUserCount: number;
    /** Total capability flags defined in the canonical catalog. */
    totalCapabilityCount: number;
  };
};

/**
 * Whether a non-admin user carries a per-user override — i.e. their stored
 * effective permission set differs from the set their role baselines (+ any
 * assigned custom role) would produce on their own. Compared as SETS via the
 * Phase-A materializer with empty overrides, so a pure-baseline user reads as
 * "no override" and any manual grant/revoke on top reads as "has override".
 */
function hasPerUserOverride(
  user: {
    role: string;
    roles: string[];
    allowed_pages: string[];
  },
  customRoleTokensById: Map<string, string[]>,
  roleIdByUser: string | null,
): boolean {
  const customRoleTokens = roleIdByUser
    ? (customRoleTokensById.get(roleIdByUser) ?? [])
    : [];
  const baselineEffective = computeEffectivePermissions({
    role: user.role,
    roles: user.roles,
    customRoleTokens,
    override: { grants: [], revokes: [] },
  });
  const actual = sanitizePermissionKeys([...user.allowed_pages]);
  if (baselineEffective.length !== actual.length) return true;
  const baseSet = new Set(baselineEffective);
  for (const t of actual) {
    if (!baseSet.has(t)) return true;
  }
  return false;
}

/** Count the page / capability / value tokens within a flat token set. */
function countTokens(tokens: readonly string[]): {
  pageCount: number;
  capabilityCount: number;
} {
  const pageCount = tokens.filter((t) => !t.startsWith("__")).length;
  const valueCount = tokens.filter(
    (t) => t.startsWith("__") && t.includes(":"),
  ).length;
  return { pageCount, capabilityCount: tokens.length - pageCount - valueCount };
}

/**
 * Build the unified Roles overview: ONE merged role list (the 6 enum roles in
 * privilege order, then custom presets alphabetically) plus the KPI counts. All
 * ADMIN-DB reads are read-only.
 *
 * Built-in token counts read the EDITABLE source — the system row's stored
 * `capabilities` (which `updateBuiltInRole` writes) — so an already-edited
 * built-in shows its current counts, NOT the code `ROLE_BASELINES` seed. The
 * `admin` superuser row is the exception: it is total-bypass, so its counts are
 * meaningless and the card renders "Full access" instead.
 */
export async function getRolesOverview(): Promise<RolesOverview> {
  // TWO ADMIN-DB round trips, issued together.
  //
  // This used to be THREE sequential awaits: a `GROUP BY role` tally, the role
  // rows, then a second pass over `admin_users` for the override count. The
  // tally and the override pass read the SAME table, so the tally is now
  // derived in code from the single `admin_users` read (staff-sized table —
  // one row per admin), and the two remaining reads run in parallel. The Admin
  // pool is `max: 4` per instance with no admission control, so a narrower,
  // shorter fan-out is what keeps this tab off the pool's connect queue.
  const [allUsers, allRoleRows] = await Promise.all([
    // Every admin_user. `role` feeds the per-role holder tally (previously the
    // dedicated GROUP BY); the remaining columns feed the per-user override
    // count below, which only considers non-admin rows.
    adminDrizzle.execute<{
      id: string; role: string; roles: string[]; role_id: string | null;
      allowed_pages: string[];
    }>(sql`
      SELECT id::text, role::text AS role, roles::text[] AS roles,
             role_id::text, allowed_pages
      FROM admin_users
    `).then((r) => r.rows),
    // Every admin_roles row (system + custom) in one read.
    adminDrizzle.execute<{
      id: string; name: string; description: string | null; is_system: boolean;
      system_key: string | null; capabilities: string[]; landing_route: string | null;
      updated_at: Date | string; user_count: string;
    }>(sql`
      SELECT r.id::text, r.name, r.description, r.is_system, r.system_key,
             r.capabilities, r.landing_route, r.updated_at,
             COUNT(u.id)::text AS user_count
      FROM admin_roles r
      LEFT JOIN admin_users u ON u.role_id = r.id
      GROUP BY r.id
      ORDER BY r.name ASC
    `).then((r) => r.rows),
  ]);

  // Byte-identical to the retired `SELECT role, COUNT(*) … GROUP BY role`:
  // one bucket per distinct `role` column value across every admin_users row.
  const holdersByRole = new Map<string, number>();
  for (const u of allUsers) {
    holdersByRole.set(u.role, (holdersByRole.get(u.role) ?? 0) + 1);
  }

  // Index the system rows by their enum key so each built-in's id / edited caps
  // can be looked up; collect the custom rows separately for the merge.
  type RoleRow = (typeof allRoleRows)[number];
  const systemRowByKey = new Map<AdminRole, RoleRow>();
  const customRows: RoleRow[] = [];
  const customTokensById = new Map<string, string[]>();
  for (const r of allRoleRows) {
    const key = r.system_key;
    if (r.is_system && key && (ALL_ADMIN_ROLES as readonly string[]).includes(key)) {
      systemRowByKey.set(key as AdminRole, r);
    } else {
      customRows.push(r);
      customTokensById.set(r.id, r.capabilities);
    }
  }

  // ── 3a. The 6 enum roles, in privilege order (admin first) ────────────────
  const systemSummaries: RoleSummary[] = ALL_ADMIN_ROLES.map((role) => {
    const baseline = ROLE_BASELINES[role];
    const row = systemRowByKey.get(role);
    // The editable source: the system row's stored caps. Fall back to the code
    // baseline tokens only if the system row is missing (shouldn't happen).
    const tokens = row?.capabilities ?? [...baseline.tokens];
    const { pageCount, capabilityCount } = countTokens(tokens);
    return {
      id: row?.id ?? null,
      key: role,
      name: row?.name ?? baseline.label,
      description: row?.description ?? null,
      isSystem: true,
      systemKey: role,
      isSuperuser: baseline.bypass,
      pageCount,
      capabilityCount,
      tokenCount: tokens.length,
      holderCount: holdersByRole.get(role) ?? 0,
      landingRoute: row?.landing_route ?? null,
      updatedAt: new Date(row?.updated_at ?? 0).toISOString(),
    };
  });

  // ── 3b. Custom presets (already alphabetical from the ordered read) ───────
  const customSummaries: RoleSummary[] = customRows.map((r) => {
    const { pageCount, capabilityCount } = countTokens(r.capabilities);
    return {
      id: r.id,
      key: r.id,
      name: r.name,
      description: r.description,
      isSystem: false,
      systemKey: null,
      isSuperuser: false,
      pageCount,
      capabilityCount,
      tokenCount: r.capabilities.length,
      holderCount: Number(r.user_count),
      landingRoute: r.landing_route ?? null,
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  });

  // ONE list: the protected backbone first, then the editable presets.
  const roles = [...systemSummaries, ...customSummaries];

  // ── 4. KPI counts ─────────────────────────────────────────────────────────
  const adminCount = holdersByRole.get("admin") ?? 0;

  // Per-user override count: every NON-admin admin_user (the old query's
  // `WHERE role <> 'admin'`, applied here to the single read above) compared
  // against their baseline-implied set.
  const nonAdminUsers = allUsers.filter((u) => u.role !== "admin");

  let overrideUserCount = 0;
  for (const u of nonAdminUsers as Array<{
    role: string;
    roles?: string[];
    role_id: string | null;
    allowed_pages: string[];
  }>) {
    const effRoles = getEffectiveRoles(u.role, u.roles ?? []);
    if (effRoles.includes("admin")) continue;
    if (
      hasPerUserOverride(
        { role: u.role, roles: u.roles ?? [], allowed_pages: u.allowed_pages },
        customTokensById,
        u.role_id,
      )
    ) {
      overrideUserCount++;
    }
  }

  return {
    roles,
    kpis: {
      roleCount: roles.length,
      adminCount,
      overrideUserCount,
      totalCapabilityCount: CAPABILITY_KEYS.length,
    },
  };
}
