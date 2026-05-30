import "server-only";

import { adminDb } from "@/lib/admin-db";

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
 * Safe to call from anywhere — uses `adminDb` directly, no session
 * required, idempotent UPDATE with a NOT-EXISTS guard.
 */
export async function ensureSupportBaseline(): Promise<void> {
  if (ensured) return;
  try {
    // Single UPDATE per missing page key — both statements are
    // guarded by `NOT (… = ANY(allowed_pages))` so they no-op for
    // users that already have access.
    await adminDb.$executeRawUnsafe(
      `UPDATE "admin_users"
          SET "allowed_pages" = array_append("allowed_pages", '/users')
        WHERE role = 'support'
          AND NOT ('/users' = ANY("allowed_pages"))`,
    );
    await adminDb.$executeRawUnsafe(
      `UPDATE "admin_users"
          SET "allowed_pages" = array_append("allowed_pages", '/dashboard')
        WHERE role = 'support'
          AND NOT ('/dashboard' = ANY("allowed_pages"))`,
    );
    ensured = true;
  } catch (err) {
    // Don't crash the page on a back-fill failure — surface it in the
    // server log and let the next caller retry on a transient blip.
    ensured = false;
    console.error("[support] ensureSupportBaseline failed:", err);
  }
}
