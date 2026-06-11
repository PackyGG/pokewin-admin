import { adminDb } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";
import type { SessionPayload } from "@/lib/session";

/**
 * Single-account allowlist for the "export ALL users" CSV button on
 * /users. ONLY the `motha` admin may generate that export — it dumps
 * every user's email + total deposited in one shot (raw PII, no
 * staff-exclusion), so access is deliberately tighter than the
 * capability-gated `/api/users/export` dialog that any admin (or a
 * `__can_export_users` grantee) can use.
 *
 * Mirrors the established per-feature username gates
 * (`src/lib/excluded-users/gate.ts`, `src/lib/salary/motha-gate.ts`):
 * a private allowlist + a live `admin_users.username` lookup. We keep
 * this scope-local instead of reusing the excluded-users gate so the
 * two access boundaries can't silently widen each other — if the
 * excluded-users blacklist is ever opened up, this export must NOT
 * follow. Match is case-insensitive against `admin_users.username`.
 *
 * If ownership ever needs to widen, change this one constant.
 */
const ALLOWED_USERNAMES = ["motha"] as const;

/**
 * Throwing server-side gate for the export Server Action. Resolves the
 * current admin, reads their CURRENT username from the DB (verifySession
 * carries a login-time username snapshot that goes stale if the admin is
 * renamed — re-querying keeps the check truthful), and throws if it
 * isn't motha. The action returns the thrown message to the client; it
 * NEVER returns the export data to a non-motha caller.
 *
 * Unlike the page gates this throws rather than `redirect()`s: the
 * caller is an RPC-style Server Action returning a CSV string, not a
 * route render, so an error result is the correct control flow.
 */
export async function requireUsersExportAdmin(): Promise<
  SessionPayload & { username: string }
> {
  const session = await verifySession();

  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });

  if (!user?.is_active || !isAllowed(user.username)) {
    throw new Error("Not permitted.");
  }

  return { ...session, username: user.username };
}

/**
 * Non-throwing variant for conditionally rendering the button. Used by
 * the /users server component to decide whether to pass the island a
 * `true` flag. Purely cosmetic — `requireUsersExportAdmin` above is the
 * real security boundary on the action itself.
 */
export async function canExportAllUsers(userId: string): Promise<boolean> {
  const user = await adminDb.admin_users.findUnique({
    where: { id: userId },
    select: { username: true, is_active: true },
  });
  return Boolean(user?.is_active && isAllowed(user.username));
}

/**
 * Pure username predicate for callers that already hold the live
 * `admin_users` row (e.g. the consolidated /users page-gate read, which
 * fetches the row ONCE for several render flags instead of issuing a
 * separate lookup per gate). Purely cosmetic, same as
 * {@link canExportAllUsers} — the throwing {@link requireUsersExportAdmin}
 * stays the real security boundary on the export action. Callers must
 * still AND this with `is_active` themselves.
 */
export function isUsersExportAdminUsername(username: string): boolean {
  return isAllowed(username);
}

function isAllowed(username: string): boolean {
  const lower = username.toLowerCase();
  return ALLOWED_USERNAMES.some((u) => u === lower);
}
