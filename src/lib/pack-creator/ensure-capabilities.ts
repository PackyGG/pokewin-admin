import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level cache so we only hit the DB once per server process.
// Reset to false on failure so a transient error doesn't lock out
// the back-fill for the lifetime of the deploy.
let ensured = false;

/**
 * Idempotent runtime back-fill: grants `__can_update_pack` to every
 * admin_user with role 'pack_creator' that's missing it. Mirrors the
 * SQL migration at
 * prisma/admin/migrations/20260506000000_pack_creator_grant_update_pack.
 *
 * The new default in admin-users/actions.ts already includes the
 * capability for fresh users, but existing pack_creator accounts
 * were created before that change and have a stale allowed_pages
 * array. Without this back-fill, the only way to give them edit
 * access is for an admin to flip the capability via
 * /settings/roles → Pack Creator. Running the SQL via a defensive
 * runtime self-heal makes the change "just work" on first /packs
 * page load after deploy, same pattern /shifts and /salaries use.
 *
 * Server-side, updatePack still refuses to touch active=true packs
 * when session.role = 'pack_creator', so granting the capability
 * alone can't let pack_creators edit live packs.
 */
export async function ensurePackCreatorCapabilities(): Promise<void> {
  if (ensured) return;
  try {
    await adminDb.$executeRawUnsafe(
      `UPDATE "admin_users"
          SET "allowed_pages" = array_append("allowed_pages", '__can_update_pack')
        WHERE role = 'pack_creator'
          AND NOT ('__can_update_pack' = ANY("allowed_pages"))`,
    );
    ensured = true;
  } catch (err) {
    // Don't crash the page on a back-fill failure — the capability
    // is non-critical for the page to render. Reset so a future
    // caller retries (e.g. transient connection blip).
    ensured = false;
    console.error(
      "[pack-creator] ensurePackCreatorCapabilities failed:",
      err,
    );
  }
}
