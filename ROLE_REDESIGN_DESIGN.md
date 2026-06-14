# Admin Role/Permission Rebuild — Implementation Brief (behavior-preserving)

> Source of truth for the rebuild. **Hard constraint (owner):** keep ALL current roles and every existing user's exact allowance — nothing any admin can do today may change. Proven by a read-only parity harness before any cutover.

## Parity guarantee (by construction)
The runtime gate reads ONE thing for non-admins: the materialized `allowed_pages` array (`getUserPermissions` → `pageAccessGranted`/`hasCapability`). The rebuild **does not change what the gate reads, the matching semantics, or any row's `allowed_pages` at migration.** It introduces a new *editable source* (locked role baselines + explicit per-user grants/revokes) whose materializer is defined to reproduce the exact current array per user. Cutover is gated by the parity harness asserting `materialize(newModel(user)) == user.allowed_pages` (set-equal) for all 17 users.

## Three-layer model
```
effective(user) = sanitize(
    ⋃ over r in roles(user) of BASELINE[r]   // locked built-ins + custom-role capabilities
  ∪ user.permission_grants                   // explicit additive grants
  \ user.permission_revokes )                // revokes win over baseline+grants
```
- **Layer 1 — locked built-in baselines (code-defined):** the 6 enum roles get canonical token sets (below), rendered read-only in the editor (owner forbids changing role effects). `admin` baseline = `[]` and is the total-bypass sentinel (gate returns `[]`, short-circuits — identical to `dal.ts:111`).
- **Layer 2 — custom roles (`admin_roles` table, unchanged):** the dormant `creator manager` row (capabilities `[]`, linked to `dex`) preserved verbatim; its `capabilities` contribute to any holder's baseline.
- **Layer 3 — per-user overrides (NEW):** two additive nullable columns `permission_grants String[]` / `permission_revokes String[]` on `admin_users`. Empty at migration; derived per user so `baseline ∪ grants \ revokes == current allowed_pages`.

`allowed_pages` stays the runtime cache: every editor save re-materializes it via ONE canonical function, replacing the 5 divergent write paths. Gate read path unchanged.

## Canonical baselines (derived from live intersections — LOCKED)
```js
const BASELINE = {
  admin: [], // total-bypass sentinel — MUST stay []
  support: [
    "/shifts","/users","/transactions/packs","/transactions/rewards",
    "/transactions/deposits","/chat","/withdrawals","/dashboard",
    "__can_edit_identity","__can_ban_users","__can_lock_users",
    "__can_toggle_feature_locks","__can_create_user_note","__can_mute_users",
    "__can_delete_messages","__can_pin_messages",
  ], // 16 tokens — Jason/quaticy/Rot byte-identical; dex shares all 16
  pack_creator: [
    "/packs","/cards","/sets","/upgrader","/rewards/shards",
    "__can_create_pack","__can_update_pack","__can_edit_live_packs",
    "__can_upload_pack_image","__can_create_card","__can_update_card",
    "__can_delete_card","__can_upload_card_image","__can_create_set",
    "__can_delete_pack","__can_toggle_pack_active","__can_update_set",
    "__can_delete_set","__can_seed_initial_sets","__can_force_absorb_cards",
    "__can_upload_set_image","__can_add_upgrader_output",
    "__can_toggle_upgrader_output","__can_remove_upgrader_output",
  ], // 24 tokens = PACK_CREATOR_DEFAULT_PAGES exactly (Skailer)
  marketing: [],        // no holder live
  creator: [],          // no holder live
  creator_manager: [],  // no ENUM holder live (custom 'creator manager' role is separate)
};
```
Per-user reconciliation (all 17 ✅): support users → 16/16; Skailer → 24/24; dex → 16∪24 = 40/40 (custom role adds nothing); admins → grants record their stored array but gate returns `[]`; `void` → grants include the verbatim value token `__balance_limit_daily:10`; `e2e_admin` → empty `roles[]` preserved.

## New code (Phase A — behavior-neutral)
`src/lib/permissions/types.ts`: `PermissionToken`, `RoleBaseline{role,label,tokens,locked,bypass,stickyTokens}`, `PermissionOverride{grants,revokes}`, `UserPermissionInput{role,roles,customRoleTokens,override}`.

`src/lib/permissions/materialize.ts`:
```ts
export function computeEffectivePermissions(input: UserPermissionInput): PermissionToken[] {
  const roles = getEffectiveRoles(input.role, input.roles);
  if (roles.includes("admin")) return []; // total bypass — matches dal.ts:111
  const set = new Set<PermissionToken>();
  for (const r of roles) for (const t of baselineTokensFor(r)) set.add(t);
  for (const t of input.customRoleTokens) set.add(t);
  for (const t of input.override.grants) set.add(t);
  for (const t of input.override.revokes) set.delete(t);
  return sanitizePermissionKeys([...set]); // value-token-aware (see below)
}
```
Pure; shared by write paths AND the harness.

`src/lib/role-baselines.ts` (REWRITE, keep filename + the exported `computeAllowedPagesForRoles(roles): Promise<string[]>` signature so `createAdminUser` is unchanged): replace the "copy allowed_pages off the first existing user" logic with code-defined `ROLE_BASELINES: Record<AdminRole, RoleBaseline>` + `baselineTokensFor(role)`. For existing single roles this yields the same set the copy-logic produces today (support 16, pack_creator 24). **Fresh-create nuance:** new-user seeds for the UNUSED roles use the clean code baseline; this changes NO existing user (document it).

`src/lib/admin-user-roles.ts`: add `readAdminUserWithOverrides` mirroring `readAdminUserWithRoles` (P2022 degrade → `{grants:[],revokes:[]}`) so reads are safe BEFORE the columns exist → behavior identical pre/post DB-apply.

`permissions-utils.ts`: make `sanitizePermissionKeys` **value-token-aware** — preserve tokens like `__balance_limit_daily:<n>` / `__can_*:<value>` whose base key/known prefix is recognized (today it would DROP `void`'s `__balance_limit_daily:10`). Mandatory before any canonical re-write touches an admin's array.

`scripts/permission-parity-harness.mjs` (READ-ONLY): re-probe ADMIN DB read-only → `scripts/parity-target.json` (uncommitted), then for every user assert `materialize(baseline ∪ grants \ revokes) == current allowed_pages` set-equal (admins: gate-visible `[]` AND stored array round-trips). Exit 0 only if all 17 reconcile; print the derived override plan (feeds the owner-gated backfill SQL). Commit a no-DB fixture variant as a CI test.

### Phase A must NOT
touch `dal.ts` gate logic, `admin-pages.ts` logic, the DB schema/columns (ships before columns exist via P2022 degrade), the MAIN DB, `.env`, `src/generated`, or the password-reset agent's files (`admin-header.tsx`, `profile/*`, `admin-users/[id]/audit-events-table.tsx`). No write-path behavior changes yet. `allowed_pages` untouched.

## Schema (Phase C — additive, OWNER-GATED, `prisma db execute`, never migrate)
```sql
ALTER TABLE "admin_users"
  ADD COLUMN IF NOT EXISTS "permission_grants"  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "permission_revokes" text[] NOT NULL DEFAULT '{}';
```
Rollback: `DROP COLUMN IF EXISTS ...`. Does not read/alter/clear `allowed_pages`, the enum, or MAIN. Backfill grants/revokes from the harness plan (idempotent). 

## Phased rollout (each independently verifiable: tsc + lint + `npm run build` + harness green + render)
- **A (now):** core lib + harness; allowed_pages untouched, columns not applied → zero behavior change. Pushable alone.
- **B:** new `/settings/roles` overview + read-only role inspector UI (house modern-page pattern: PageHero/SectionHeading/KpiTile/StatPanel, dark mode); built-ins shown locked. No write-path change.
- **C (owner-gated DB apply):** owner runs the ALTER + backfill; then switch `updateUserPermissions`/custom-role actions/`setAdminRoles` to the canonical re-materializer; ship the per-user grants/revokes editor with a save-preview diff; retire the blunt `updateMany` overwrite + divergent dual-axis materialization. Keep the sticky self-heals unless owner opts out.
- **D (optional safety, owner opt-in):** last-admin guard, self-demotion guard, real session revocation (`sessions_valid_after`), mandatory-2FA. None change any role's page/capability allowance.

## Highest-attention risk
`__balance_limit_daily:10` (void) — current sanitizer would drop it; make sanitizer value-token-aware first. Harness asserts it round-trips. void is an admin (gate bypass) so the gate is unaffected today, but the override layer must store it verbatim.
