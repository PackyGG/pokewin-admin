import "server-only";

import { adminDb } from "@/lib/admin-db";
import { isMissingColumnError } from "@/lib/admin-user-roles";

// Module-level cache so we only hit the DB once per server process.
// Reset to false on failure so a transient error doesn't lock out
// the back-fill for the lifetime of the deploy.
let ensured = false;

/**
 * The full out-of-the-box permission set for the `pack_creator` role:
 * the five content pages it works on plus every content capability for
 * packs, cards, sets and the upgrader output pool. This is the single
 * source of truth shared by:
 *
 *   - the fresh-user default in admin-users/actions.ts (createAdminUser),
 *   - the runtime self-heal `ensurePackCreatorCapabilities` below, which
 *     back-fills existing pack_creator rows.
 *
 * The role's whole purpose is content management, so "do anything for
 * packs / sets / cards" is its baseline. Capabilities are stored as
 * `__can_*` entries in the same `allowed_pages` String[] column as page
 * routes (see settings/roles/permissions-utils.ts); they're listed here
 * verbatim — each one matches a key the corresponding server action
 * gates on.
 *
 * Note on live packs: `__can_edit_live_packs` is included, but updatePack
 * still routes a pack_creator editing an active pack through that exact
 * capability check (src/app/(admin)/packs/actions.ts). Granting it here
 * is what lets a pack_creator edit a live pack — by design, per the role
 * being able to fully manage packs.
 */
export const PACK_CREATOR_DEFAULT_PAGES: readonly string[] = [
  // Pages — needed both for the sidebar (built from allowed_pages) and
  // for requirePageAccess on each page to pass.
  "/packs",
  "/cards",
  "/sets",
  "/upgrader",
  // Packs
  "__can_create_pack",
  "__can_update_pack",
  "__can_delete_pack",
  "__can_toggle_pack_active",
  "__can_edit_live_packs",
  "__can_upload_pack_image",
  // Cards
  "__can_create_card",
  "__can_update_card",
  "__can_delete_card",
  "__can_upload_card_image",
  // Sets
  "__can_create_set",
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
 * Idempotent runtime back-fill: grants every key in
 * `PACK_CREATOR_DEFAULT_PAGES` to any admin_user with role
 * 'pack_creator' that's missing it, on the first /packs page load after
 * deploy (same self-heal pattern /shifts, /salaries and the support
 * baseline use — see src/lib/support-baseline.ts).
 *
 * Why this exists:
 *   The fresh-user default in admin-users/actions.ts only applies at
 *   creation time. Existing pack_creator accounts were created before
 *   the role could fully manage packs/sets/cards and have a stale
 *   allowed_pages array. Without this back-fill the only way to give
 *   them the full content permission set is for an admin to re-save
 *   /settings/roles → Pack Creator. This makes it "just work".
 *
 * Trade-off (identical to ensureSupportBaseline):
 *   These keys become sticky for the pack_creator role — if an admin
 *   revokes one from an individual pack_creator via the per-user editor,
 *   the next /packs visit re-grants it. To genuinely restrict a single
 *   employee, change their role instead of stripping keys. This matches
 *   the user's intent that the pack_creator role can fully manage
 *   packs / sets / cards.
 *
 * Each key is appended with a `NOT (… = ANY(allowed_pages))` guard so
 * the statement no-ops for keys the user already holds and never
 * duplicates an entry.
 */
export async function ensurePackCreatorCapabilities(): Promise<void> {
  if (ensured) return;
  try {
    await runPackCreatorBaseline(true);
    ensured = true;
  } catch (err) {
    // If the additive `roles` column hasn't been migrated yet, the
    // `ANY("roles")` predicate throws P2022. Retry the legacy
    // single-role-only form so existing pack_creator rows still get their
    // capability baseline exactly as before multi-role shipped.
    if (isMissingColumnError(err)) {
      try {
        await runPackCreatorBaseline(false);
        ensured = true;
        return;
      } catch (legacyErr) {
        ensured = false;
        console.error(
          "[pack-creator] ensurePackCreatorCapabilities failed:",
          legacyErr,
        );
        return;
      }
    }
    // Don't crash the page on a back-fill failure — the capabilities
    // are non-critical for the page to render. Reset so a future
    // caller retries (e.g. transient connection blip).
    ensured = false;
    console.error(
      "[pack-creator] ensurePackCreatorCapabilities failed:",
      err,
    );
  }
}

// Append every missing key with a `NOT (… = ANY(allowed_pages))` guard so
// the statement no-ops for keys the user already holds. When
// `includeRolesArray` is true it matches BOTH legacy single-role rows
// (role = 'pack_creator') AND multi-role rows that merely INCLUDE
// pack_creator among `roles`. When false (the `roles` column hasn't been
// migrated yet) it matches the legacy single-role rows only.
async function runPackCreatorBaseline(includeRolesArray: boolean): Promise<void> {
  for (const key of PACK_CREATOR_DEFAULT_PAGES) {
    if (includeRolesArray) {
      // The `::"admin_role"` cast keeps the array-membership test
      // type-safe.
      await adminDb.$executeRaw`
        UPDATE "admin_users"
           SET "allowed_pages" = array_append("allowed_pages", ${key})
         WHERE (role = 'pack_creator' OR 'pack_creator'::"admin_role" = ANY("roles"))
           AND NOT (${key} = ANY("allowed_pages"))`;
    } else {
      await adminDb.$executeRaw`
        UPDATE "admin_users"
           SET "allowed_pages" = array_append("allowed_pages", ${key})
         WHERE role = 'pack_creator'
           AND NOT (${key} = ANY("allowed_pages"))`;
    }
  }
}
