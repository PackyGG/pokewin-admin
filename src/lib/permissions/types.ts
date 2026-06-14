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
 * - `stickyTokens` — tokens that a runtime self-heal re-grants on the role's
 *              landing page even if an admin strips them per-user (the
 *              existing `ensureSupportBaseline` / `ensurePackCreatorCapabilities`
 *              behavior). Carried here for documentation + Phase C; Phase A
 *              does not act on it. Always a subset of `tokens`.
 */
export type RoleBaseline = {
  role: AdminRole;
  label: string;
  tokens: PermissionToken[];
  locked: boolean;
  bypass: boolean;
  stickyTokens: PermissionToken[];
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
 */
export type UserPermissionInput = {
  role: string;
  roles: readonly string[] | null | undefined;
  customRoleTokens: readonly PermissionToken[];
  override: PermissionOverride;
};
