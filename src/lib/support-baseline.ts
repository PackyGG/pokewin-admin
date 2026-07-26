import "server-only";

import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { isMissingColumnError } from "@/lib/admin-user-roles";

// Module-level cache so we only hit the DB once per server process.
// Reset to false on failure so a transient error doesn't lock out
// the back-fill for the lifetime of the deploy.
let ensured = false;

/**
 * Idempotent runtime back-fill: grants `/users` (and `/dashboard` as the
 * sensible landing page) to every admin_user with role 'support' that's
 * missing it.
 *
 * Why this exists:
 *   `/users` is canonical-for-support — the entire support workflow
 *   (look up a user, open their detail, adjust balances, leave notes,
 *   process refunds) starts from /users. If an admin accidentally saves
 *   /settings/roles → Support with /users unchecked, the bulk
 *   `updateRolePermissions` action wipes /users from every support
 *   employee in one shot, and the support team is silently locked out
 *   until someone notices and re-grants it.
 *
 *   This back-fill makes /users sticky for the support role: even if
 *   the role editor is saved without it, the next /users visit
 *   re-grants it. Mirrors the same protection
 *   `ensurePackCreatorCapabilities` gives `__can_update_pack` for
 *   pack_creator (see src/lib/pack-creator/ensure-capabilities.ts).
 *
 * Trade-off:
 *   Once this baseline is enforced, an admin can't permanently strip
 *   /users from an individual support user via the per-user editor —
 *   the next page load re-grants it. If you want to revoke /users
 *   from a specific employee, change their role to something else
 *   (marketing / custom role) or remove the user. Same trade-off
 *   `ensurePackCreatorCapabilities` already makes.
 *
 * Safe to call from anywhere — uses the admin Drizzle client directly, no session
 * required, idempotent UPDATE with a NOT-EXISTS guard.
 */
export async function ensureSupportBaseline(): Promise<void> {
  if (ensured) return;
  try {
    await runSupportBaseline(true);
    ensured = true;
  } catch (err) {
    // If the additive `roles` column hasn't been migrated yet, the
    // `ANY("roles")` predicate throws 42703. Retry the legacy
    // single-role-only form so the /users + /dashboard baseline still
    // self-heals exactly as it did before multi-role shipped. Behaviour
    // is then identical to the pre-migration code path.
    if (isMissingColumnError(err)) {
      try {
        await runSupportBaseline(false);
        ensured = true;
        return;
      } catch (legacyErr) {
        ensured = false;
        console.error("[support] ensureSupportBaseline failed:", legacyErr);
        return;
      }
    }
    // Don't crash the page on a back-fill failure — surface it in the
    // server log and let the next caller retry on a transient blip.
    ensured = false;
    console.error("[support] ensureSupportBaseline failed:", err);
  }
}

// Single UPDATE per missing page key — both statements are guarded by
// `NOT (… = ANY(allowed_pages))` so they no-op for users that already
// have access. When `includeRolesArray` is true each matches BOTH legacy
// single-role rows (role = 'support') AND multi-role rows that merely
// INCLUDE support among `roles`. When false (the `roles` column hasn't
// been migrated yet) it matches the legacy single-role rows only.
async function runSupportBaseline(includeRolesArray: boolean): Promise<void> {
  const match = includeRolesArray
    ? `(role = 'support' OR 'support'::"admin_role" = ANY("roles"))`
    : `role = 'support'`;
  await adminDrizzle.execute(sql.raw(
    `UPDATE "admin_users"
        SET "allowed_pages" = array_append("allowed_pages", '/users')
      WHERE ${match}
        AND NOT ('/users' = ANY("allowed_pages"))`,
  ));
  await adminDrizzle.execute(sql.raw(
    `UPDATE "admin_users"
        SET "allowed_pages" = array_append("allowed_pages", '/dashboard')
      WHERE ${match}
        AND NOT ('/dashboard' = ANY("allowed_pages"))`,
  ));
}
