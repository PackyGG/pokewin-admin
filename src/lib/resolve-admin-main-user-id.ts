import { eq, sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { getDrizzleDb } from "@/lib/db";

/**
 * Resolve a Main-DB `User.id` for the calling admin so it can be written
 * into FK columns that reference the Main-DB `User` table (e.g.
 * `user.banned_by`, `user.locked_by`, `user_mutes.muted_by`).
 *
 * Background: admin identities live in the Admin DB (`admin_users`),
 * which is a separate database from the Main DB (`User`). Columns like
 * `user.banned_by` / `user.locked_by` are nullable FKs to `User.id`, so a
 * raw `session.userId` (an admin_users.id UUID) would either fail with a
 * FK violation or — worse — accidentally reference whichever Main-DB
 * user happens to share that UUID.
 *
 * Linking is by email: `admin_users.email` is kept in sync with the
 * Main-DB `User.email` for creator-role admins (see
 * `linkCreatorToMainUser`). For non-linked admins this returns null and
 * the caller must fall back. The authoritative attribution is always the
 * admin audit event written via `createAdminAuditEvent`.
 *
 * Limitation: best-effort by email match only. Admins without a matching
 * Main-DB User row return null. Callers must handle the null case
 * (typically: write null to the FK column AND record the resolved id in
 * the audit metadata so the trail isn't lost).
 *
 * Mirrors the pattern in `src/app/(admin)/chat/actions.ts`
 * (`resolveAdminMainUserId`) — kept as a shared module so the same
 * resolution logic can be reused by other Main-DB writers (ban, lock,
 * etc.) without duplication.
 */
export async function resolveAdminMainUserId(
  adminUserId: string,
): Promise<string | null> {
  const [adminUser] = await adminDrizzle.select({ email: admin_users.email })
    .from(admin_users).where(eq(admin_users.id, adminUserId)).limit(1);
  if (!adminUser?.email) return null;

  const db = await getDrizzleDb();
  const mainUser = (
    await db.execute<{ id: string }>(
      sql`SELECT id FROM "user" WHERE email = ${adminUser.email} LIMIT 1`,
    )
  ).rows[0];
  return mainUser?.id ?? null;
}
