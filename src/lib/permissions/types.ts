/**
 * Phase A — behavior-neutral core types for the role/permission rebuild.
 *
 * These types describe the NEW editable source of an admin user's effective
 * permission set (locked role baselines + per-user grants/revokes). They do
 * NOT change anything the runtime gate reads today: the gate still reads the
 * materialized `allowed_pages` array (see `getUserPermissions` in
 * `src/lib/dal.ts`). This module only introduces the vocabulary the
 * materializer (`src/lib/permissions/materialize.ts`) and the parity harness
 * (`scripts/permission-parity-harness.mjs`) reason about.
 *
 * See `ROLE_REDESIGN_DESIGN.md` (§"New code (Phase A)") for the full brief.
 */

import type { AdminRole } from "@/lib/admin-roles";
import type { BaselineMap } from "@/lib/role-baselines";

/**
 * A single permission token. Tokens live in the same flat vocabulary the
 * existing `allowed_pages` String[] column already uses:
 *
 *   • page routes      — "/dashboard", "/users", …   (from ADMIN_PAGES)
 *   • capability flags  — "__can_ban_users", …         (from CAPABILITIES)
 *   • value tokens      — "__balance_limit_daily:10", "__can_adjust_balance_limit_daily:500", …
 *
 * A plain string alias (not a union) so it stays a drop-in for every
 * existing `string[]` permission API. Value tokens carry a `<base>:<value>`
 * suffix; recognition of those is handled by the value-token-aware
 * `sanitizePermissionKeys` in
 * `src/app/(admin)/settings/roles/permissions-utils.ts`.
 */
export type PermissionToken = string;

/**
 * A code-defined, LOCKED baseline for one built-in system role. The owner
 * forbids changing what a built-in role grants, so these are rendered
 * read-only in the editor and are the canonical source the materializer
 * unions over.
 *
 * - `role`   — the built-in `AdminRole` this baseline describes.
 * - `label`  — human-readable name for the role inspector UI (Phase B).
 * - `tokens` — the exact permission tokens this role confers. For `admin`
 *              this MUST be `[]` (the total-bypass sentinel — the gate
 *              returns `[]` and short-circuits all page/capability checks,
 *              identical to `dal.ts`'s `admin`-among-roles branch).
 * - `locked` — whether the baseline is editable in the UI. Built-ins are
 *              always `true` (owner policy: role effects don't change).
 * - `bypass` — `true` only for `admin`: holders bypass the page list
 *              entirely. Distinguishes "intentionally empty baseline because
 *              this role bypasses the gate" (admin) from "empty baseline
 *              because the role has no live holder yet" (marketing/creator/…).
 * - `stickyTokens` — tokens the canonical materializer always re-adds after
 *              per-user revokes. This preserves the role invariant without
 *              database writes during page rendering. Always a subset of
 *              `tokens`.
 * - `limits`  — OPTIONAL typed per-role limit slots (RoleV2 P0). All-null in
 *              the behavior-neutral foundation phase; mirrors the six
 *              `*_limit_*` columns on the `admin_roles` system row. Omitted /
 *              `EMPTY_ROLE_LIMITS` means "no per-role cap" (the state today).
 */
export type RoleBaseline = {
  role: AdminRole;
  label: string;
  tokens: PermissionToken[];
  locked: boolean;
  bypass: boolean;
  stickyTokens: PermissionToken[];
  limits?: RoleLimits;
};

/**
 * Typed per-role limit slots (RoleV2 P0). Mirrors the six `*_limit_*` Decimal
 * columns on `admin_roles`. A `null` slot = "no cap for this period". All
 * `null` in the behavior-neutral foundation phase (limits live per-user in
 * `admin_balance_limits` / value tokens today); these are the future home of
 * per-role caps. `issuance` (gift-card / voucher issuance caps) is optional —
 * a role may carry only balance-adjustment caps.
 */
export type RoleLimits = {
  balanceAdjustment: {
    daily: number | null;
    weekly: number | null;
    monthly: number | null;
  };
  issuance?: {
    daily: number | null;
    weekly: number | null;
    monthly: number | null;
  };
};

/** The all-null limit set — "no per-role cap" (every role's state today). */
export const EMPTY_ROLE_LIMITS: RoleLimits = {
  balanceAdjustment: { daily: null, weekly: null, monthly: null },
  issuance: { daily: null, weekly: null, monthly: null },
};

/**
 * A role as a unified, editable definition (RoleV2 P1). Spans BOTH a built-in
 * `admin_roles` system row (`systemKey` set, `isSystem === true`) AND a custom
 * role (`systemKey === null`, `isSystem === false`). The materializer does NOT
 * consume this directly — it remains a flat-token function — but the editor /
 * baseline-map seam reasons in these terms. `capabilities` is the flat token
 * set (page routes ∪ `__can_*` flags ∪ value tokens) byte-equal to a built-in
 * row's `ROLE_BASELINES[systemKey].tokens` at migration.
 */
export type RoleDefinition = {
  id: string;
  name: string;
  description: string | null;
  /** The built-in enum key, or `null` for a custom role. */
  systemKey: AdminRole | null;
  isSystem: boolean;
  capabilities: PermissionToken[];
  limits: RoleLimits;
};

/**
 * The per-user override layer (NEW). Two additive sets:
 *
 * - `grants`  — tokens granted to this user ON TOP of their role baselines
 *               (and any custom-role tokens). Additive.
 * - `revokes` — tokens taken away from this user; a revoke WINS over a
 *               baseline/grant for the same token (applied last in the
 *               materializer).
 *
 * Empty for every user at migration. The Phase A DB columns
 * (`admin_users.permission_grants` / `permission_revokes`) do not exist yet —
 * reads degrade to `{ grants: [], revokes: [] }` via
 * `readAdminUserWithOverrides`, so this shape is safe before the columns ship.
 */
export type PermissionOverride = {
  grants: PermissionToken[];
  revokes: PermissionToken[];
};

/**
 * The complete input the materializer needs to compute one user's effective
 * permission tokens.
 *
 * - `role`             — the canonical primary `admin_role` (singular column).
 * - `roles`            — the additive multi-role array (may be empty → the
 *                        effective set collapses to `[role]` via
 *                        `getEffectiveRoles`, matching legacy single-role).
 * - `customRoleTokens` — capability tokens contributed by any assigned CUSTOM
 *                        role (the `admin_roles` table's `capabilities`).
 *                        Empty when the user holds no custom role.
 * - `override`         — the per-user grants/revokes layer above.
 * - `baselines`        — OPTIONAL DB-backed override of the built-in role
 *                        baselines (RoleV2 P1). When supplied, the materializer
 *                        reads each built-in role's tokens from this map
 *                        instead of the code `ROLE_BASELINES`, falling back to
 *                        code for any role the map omits. Behavior-neutral at
 *                        migration (the seeded map === code).
 */
export type UserPermissionInput = {
  role: string;
  roles: readonly string[] | null | undefined;
  customRoleTokens: readonly PermissionToken[];
  override: PermissionOverride;
  baselines?: BaselineMap;
};
