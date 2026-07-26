/**
 * Code-defined, LOCKED baselines for the built-in system roles + the
 * behavior-equivalent seed helper for new admin users.
 *
 * Phase A of the role/permission rebuild (see `ROLE_REDESIGN_DESIGN.md`).
 * This file replaces the previous "copy `allowed_pages` off the first
 * existing user of this role" inheritance with canonical, code-defined
 * `ROLE_BASELINES`. The replacement is BEHAVIOR-PRESERVING for the runtime:
 *
 *   - `computeAllowedPagesForRoles(roles)` keeps its exact signature and,
 *     for the only roles with live holders (`support` → 16 tokens,
 *     `pack_creator` → 24 tokens), returns the SAME set the copy-logic
 *     produced. `createAdminUser`'s seeded `allowed_pages` is therefore
 *     unchanged for those roles.
 *
 * IMPORTANT — this module is intentionally `server-only`-FREE so the pure
 * baseline data + `baselineTokensFor` can be imported by the
 * `computeEffectivePermissions` materializer AND by a plain `node:test`
 * parity fixture (no DB, no Next server graph). The Admin DB is no longer
 * consulted here at all (see the note on the async helper below).
 */

import type { AdminRole } from "@/lib/admin-roles";
import type { RoleBaseline, PermissionToken } from "@/lib/permissions/types";

/**
 * An OPTIONAL override of the code-defined built-in baselines, keyed by
 * `AdminRole`. The DB-backed source (RoleV2 P1): the `admin_roles` system
 * rows (`system_key not null`) supply each built-in role's `capabilities` so
 * the materializer can read the EDITABLE baseline instead of the hardcoded
 * `ROLE_BASELINES`. `Partial` because a map may cover only some roles — any
 * role absent from the map falls back to the code baseline (least surprise,
 * and the behavior-neutral default before any built-in is edited).
 *
 * Built from the live rows by `getBaselineMap()`
 * (src/lib/permissions/write-paths.ts). At migration the seeded rows are
 * BYTE-EQUAL to `ROLE_BASELINES`, so a provided map produces IDENTICAL
 * materializer output — the foundation is behavior-neutral.
 */
export type BaselineMap = Partial<Record<AdminRole, PermissionToken[]>>;

/**
 * The full out-of-the-box permission set for `pack_creator`, inlined here as
 * the canonical code baseline. It is byte-equal (as a SET) to
 * `PACK_CREATOR_DEFAULT_PAGES` in
 * `src/lib/pack-creator/ensure-capabilities.ts` — that module is `server-only`
 * (it imports the admin database), so the tokens are duplicated here verbatim to keep
 * THIS module DB-free. The live parity harness proves the two stay in
 * lock-step (Skailer reconciles to exactly this set).
 */
const PACK_CREATOR_BASELINE_TOKENS: readonly PermissionToken[] = [
  // Pages
  "/packs",
  "/cards",
  "/sets",
  "/upgrader",
  // Packs
  "__can_create_pack",
  "__can_update_pack",
  "__can_edit_live_packs",
  "__can_upload_pack_image",
  // Cards
  "__can_create_card",
  "__can_update_card",
  "__can_delete_card",
  "__can_upload_card_image",
  // Sets
  "__can_create_set",
  "__can_delete_pack",
  "__can_toggle_pack_active",
  "__can_update_set",
  "__can_delete_set",
  "__can_seed_initial_sets",
  "__can_force_absorb_cards",
  "__can_upload_set_image",
  // Upgrader (output-card pool on /upgrader)
  "__can_add_upgrader_output",
  "__can_toggle_upgrader_output",
  "__can_remove_upgrader_output",
];

/**
 * The canonical `support` baseline — the exact 15 tokens every live support
 * user carries (Jason / quaticy / Rot are byte-identical; dex shares all 15).
 * Derived from the live intersection per `ROLE_REDESIGN_DESIGN.md`; the
 * parity harness proves each support user reconciles to this set.
 */
const SUPPORT_BASELINE_TOKENS: readonly PermissionToken[] = [
  // Pages
  "/shifts",
  "/users",
  "/transactions/packs",
  "/transactions/deposits",
  "/chat",
  "/withdrawals",
  "/dashboard",
  // Capabilities
  "__can_edit_identity",
  "__can_ban_users",
  "__can_lock_users",
  "__can_toggle_feature_locks",
  "__can_create_user_note",
  "__can_mute_users",
  "__can_delete_messages",
  "__can_pin_messages",
];

/**
 * The sticky subset of the support baseline — the tokens
 * `ensureSupportBaseline` re-grants on every `/users` visit
 * (src/lib/support-baseline.ts). Carried for documentation + Phase C; not
 * acted on in Phase A.
 */
const SUPPORT_STICKY_TOKENS: readonly PermissionToken[] = ["/users", "/dashboard"];

/**
 * Code-defined LOCKED baselines for every built-in `AdminRole`.
 *
 * `admin` is `[]` with `bypass: true` — the total-bypass sentinel. The
 * runtime gate (`getUserPermissions` in `src/lib/dal.ts`) returns `[]` for
 * any user with the `admin` role and short-circuits every page/capability
 * check; this baseline MUST stay empty.
 *
 * `marketing` / `creator` / `creator_manager` are `[]` because no live user
 * holds them (per the live intersection in the brief). They are NOT bypass
 * roles — an empty baseline here means "this role grants nothing by default",
 * not "this role bypasses the gate".
 */
export const ROLE_BASELINES: Record<AdminRole, RoleBaseline> = {
  admin: {
    role: "admin",
    label: "Admin",
    tokens: [],
    locked: true,
    bypass: true,
    stickyTokens: [],
  },
  support: {
    role: "support",
    label: "Support",
    tokens: [...SUPPORT_BASELINE_TOKENS],
    locked: true,
    bypass: false,
    stickyTokens: [...SUPPORT_STICKY_TOKENS],
  },
  marketing: {
    role: "marketing",
    label: "Marketing",
    tokens: [],
    locked: true,
    bypass: false,
    stickyTokens: [],
  },
  creator: {
    role: "creator",
    label: "Creator",
    tokens: [],
    locked: true,
    bypass: false,
    stickyTokens: [],
  },
  pack_creator: {
    role: "pack_creator",
    label: "Pack Creator",
    tokens: [...PACK_CREATOR_BASELINE_TOKENS],
    locked: true,
    bypass: false,
    // The whole pack_creator set is re-granted by
    // ensurePackCreatorCapabilities on every /packs visit.
    stickyTokens: [...PACK_CREATOR_BASELINE_TOKENS],
  },
  creator_manager: {
    role: "creator_manager",
    label: "Creator Manager",
    tokens: [],
    locked: true,
    bypass: false,
    stickyTokens: [],
  },
};

/**
 * The permission tokens a single built-in role confers (its baseline set).
 * Pure; the building block of `computeEffectivePermissions`. Unknown / stale
 * role strings yield `[]` (least privilege). `admin` returns `[]` here too —
 * its access is the gate bypass, not a token list, so callers that union
 * baselines still must apply the admin short-circuit themselves (the
 * materializer does).
 *
 * RoleV2 P1: an OPTIONAL `map` (the DB-backed `BaselineMap` from the
 * `admin_roles` system rows) takes precedence WHEN it has an entry for this
 * role — that is the editable source. Any role NOT in the map (or no map at
 * all) falls back to the code `ROLE_BASELINES`. Because the seeded rows are
 * byte-equal to `ROLE_BASELINES` at migration, passing the map is
 * behavior-neutral until a built-in is actually edited.
 */
export function baselineTokensFor(
  role: AdminRole | string,
  map?: BaselineMap,
): PermissionToken[] {
  if (map) {
    const fromMap = (map as Record<string, PermissionToken[] | undefined>)[role];
    if (fromMap) return [...fromMap];
  }
  const baseline = (ROLE_BASELINES as Record<string, RoleBaseline | undefined>)[
    role
  ];
  return baseline ? [...baseline.tokens] : [];
}

/**
 * Compute the seed `allowed_pages` for a NEW admin user holding `roles` —
 * the UNION of each role's code baseline.
 *
 * BEHAVIOR-PRESERVING NOTE (Phase A): the previous implementation copied the
 * preset off an existing user of each role, falling back to a fixed baseline
 * only when none existed. For the roles that have live holders this returns
 * the SAME set:
 *   - support      → the 16-token SUPPORT baseline (== every live support
 *                    user's array, which the copy-logic read off them),
 *   - pack_creator → the 24-token PACK_CREATOR baseline (== Skailer's array
 *                    == PACK_CREATOR_DEFAULT_PAGES the copy-logic read).
 * `createAdminUser` therefore seeds an IDENTICAL `allowed_pages` for new
 * support / pack_creator users, and (as before) `[]` when `admin` is among
 * the roles.
 *
 * FRESH-CREATE NUANCE (documented, affects NO existing user): for the UNUSED
 * roles (`marketing` / `creator` / `creator_manager`) there is no live holder,
 * so the old copy-logic fell back to its `fixedRoleBaseline` (e.g.
 * `creator_manager → ["/creators"]`, `support`-fallback `["/users","/dashboard"]`).
 * The new code baseline for those roles is the clean `[]`. This changes ONLY
 * the seed a hypothetical brand-new user of those roles would receive — every
 * EXISTING user keeps their stored array untouched (the parity harness proves
 * all 17 reconcile), and no current user holds those roles. An admin assigning
 * one of those roles still grants pages explicitly afterward via the role /
 * per-user editor, exactly as today.
 *
 * Kept `async` + the exact `Promise<string[]>` signature so `createAdminUser`
 * is a drop-in caller. The Admin DB is no longer consulted, but the signature
 * is preserved to avoid touching the call sites in Phase A (and Phase C may
 * reuse it).
 */
export async function computeAllowedPagesForRoles(
  roles: readonly AdminRole[],
): Promise<string[]> {
  if (roles.includes("admin")) return [];

  const union = new Set<string>();
  for (const role of roles) {
    for (const token of baselineTokensFor(role)) union.add(token);
  }
  return [...union];
}
