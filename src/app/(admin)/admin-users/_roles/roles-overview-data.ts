import "server-only";

import { adminDb } from "@/lib/admin-db";
import { readAdminUsersWithRoles } from "@/lib/admin-user-roles";
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
// Read-only data layer for the unified Roles & Permissions overview (Phase B).
//
// Everything here is READ-ONLY against the ADMIN DB. It surfaces:
//   • the canonical, code-defined built-in role baselines (ROLE_BASELINES),
//     grouped by domain for the read-only inspector, and
//   • headline counts for the KPI strip + per-role holder counts.
//
// No write path. Built-in baselines are locked (see actions.ts); custom-role
// CRUD lives in custom-roles-actions.ts and is untouched.
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

/** A built-in role, as shown on the overview grid + inspector. */
export type BuiltInRoleSummary = {
  role: AdminRole;
  /**
   * The `admin_roles` system-row id for this built-in (`system_key = role`).
   * `null` if the system row is missing (shouldn't happen post-migration) —
   * the grid then renders the card without an editor link. Used to deep-link
   * into the full per-role editor at `/admin-users/roles/[id]`.
   */
  id: string | null;
  label: string;
  /** Page-route tokens in the baseline. */
  pageCount: number;
  /** `__can_*` capability tokens in the baseline. */
  capabilityCount: number;
  /** Total tokens in the baseline (pages + capabilities + value tokens). */
  tokenCount: number;
  /** admin holders (read-only count from the ADMIN DB). */
  holderCount: number;
  /** `admin` only — the total-bypass sentinel (baseline is intentionally []). */
  bypass: boolean;
  /** Always true for built-ins (owner policy: role effects don't change). */
  locked: boolean;
  /** Tokens grouped by domain, for the read-only inspector. */
  groups: BaselineGroup[];
};

/** A custom role row for the overview grid. */
export type CustomRoleSummary = {
  id: string;
  name: string;
  description: string | null;
  tokenCount: number;
  holderCount: number;
  updatedAt: string;
};

/** Everything the overview page renders. */
export type RolesOverview = {
  builtIns: BuiltInRoleSummary[];
  customRoles: CustomRoleSummary[];
  kpis: {
    builtInCount: number;
    customCount: number;
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
 *
 * READ-ONLY: this does not write the Phase-C grants/revokes columns (which do
 * not exist yet) — it derives the delta from the live `allowed_pages` cache.
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
  // Baseline-implied effective set: role baselines ∪ custom-role tokens, with
  // NO per-user grants/revokes — i.e. exactly what this user would carry from
  // their roles alone.
  const baselineEffective = computeEffectivePermissions({
    role: user.role,
    roles: user.roles,
    customRoleTokens,
    override: { grants: [], revokes: [] },
  });
  // The user's ACTUAL stored set, sanitized through the SAME value-token-aware
  // filter so the comparison is apples-to-apples (drops stale/unknown tokens,
  // de-dupes). This is the real `allowed_pages` cache the gate reads — NOT
  // re-unioned with the baseline.
  const actual = sanitizePermissionKeys([...user.allowed_pages]);
  // Set-equality both ways: an EXTRA token (manual grant on top) or a MISSING
  // baseline token (manual revoke) both mean the user carries a per-user
  // override relative to their role baseline.
  if (baselineEffective.length !== actual.length) return true;
  const baseSet = new Set(baselineEffective);
  for (const t of actual) {
    if (!baseSet.has(t)) return true;
  }
  return false;
}

/**
 * Build the full read-only overview: built-in role summaries (with grouped
 * baseline tokens + holder counts), custom-role summaries, and the KPI strip
 * counts. All ADMIN-DB reads are read-only.
 */
export async function getRolesOverview(): Promise<RolesOverview> {
  // ── 1. Built-in role holder counts (one grouped query) ────────────────
  const roleGroups = await adminDb.admin_users.groupBy({
    by: ["role"],
    _count: { _all: true },
  });
  const holdersByRole = new Map<string, number>();
  for (const g of roleGroups) holdersByRole.set(g.role, g._count._all);

  // Map each built-in's `system_key` → its `admin_roles` row id, so the grid
  // can deep-link a built-in into the full per-role editor. Read-only.
  const systemRows = await adminDb.admin_roles.findMany({
    where: { is_system: true, system_key: { not: null } },
    select: { id: true, system_key: true },
  });
  const idBySystemKey = new Map<string, string>();
  for (const r of systemRows) {
    if (r.system_key) idBySystemKey.set(r.system_key, r.id);
  }

  const builtIns: BuiltInRoleSummary[] = ALL_ADMIN_ROLES.map((role) => {
    const baseline = ROLE_BASELINES[role];
    const tokens = baseline.tokens;
    const pageCount = tokens.filter((t) => !t.startsWith("__")).length;
    const valueCount = tokens.filter(
      (t) => t.startsWith("__") && t.includes(":"),
    ).length;
    const capabilityCount = tokens.length - pageCount - valueCount;
    return {
      role,
      id: idBySystemKey.get(role) ?? null,
      label: baseline.label,
      pageCount,
      capabilityCount,
      tokenCount: tokens.length,
      holderCount: holdersByRole.get(role) ?? 0,
      bypass: baseline.bypass,
      locked: baseline.locked,
      groups: groupBaselineTokens(tokens),
    };
  });

  // ── 2. Custom roles (admin_roles) + holder counts ─────────────────────
  const customRoleRows = await adminDb.admin_roles.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      capabilities: true,
      updated_at: true,
      _count: { select: { admin_users: true } },
    },
  });
  const customRoles: CustomRoleSummary[] = customRoleRows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    tokenCount: r.capabilities.length,
    holderCount: r._count.admin_users,
    updatedAt: r.updated_at.toISOString(),
  }));
  const customTokensById = new Map(
    customRoleRows.map((r) => [r.id, r.capabilities]),
  );

  // ── 3. KPI counts ─────────────────────────────────────────────────────
  const adminCount = holdersByRole.get("admin") ?? 0;

  // Per-user override count: read every NON-admin admin_user (roles column
  // degrades to [] pre-migration via readAdminUsersWithRoles) and compare
  // their effective set to their baseline-implied set.
  const nonAdminUsers = await readAdminUsersWithRoles(
    () =>
      adminDb.admin_users.findMany({
        where: { role: { not: "admin" } },
        select: {
          id: true,
          role: true,
          roles: true,
          role_id: true,
          allowed_pages: true,
        },
      }),
    () =>
      adminDb.admin_users.findMany({
        where: { role: { not: "admin" } },
        select: {
          id: true,
          role: true,
          role_id: true,
          allowed_pages: true,
        },
      }),
  );

  let overrideUserCount = 0;
  for (const u of nonAdminUsers as Array<{
    role: string;
    roles?: string[];
    role_id: string | null;
    allowed_pages: string[];
  }>) {
    // A user whose primary role resolves to admin (multi-role) bypasses the
    // gate — exclude from the override count (mirrors the admin short-circuit).
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
    builtIns,
    customRoles,
    kpis: {
      builtInCount: ALL_ADMIN_ROLES.length,
      customCount: customRoles.length,
      adminCount,
      overrideUserCount,
      totalCapabilityCount: CAPABILITY_KEYS.length,
    },
  };
}
