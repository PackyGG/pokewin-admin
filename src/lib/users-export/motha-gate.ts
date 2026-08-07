import { verifySession, sessionIsOwner } from "@/lib/dal";
import { isOwnerById, isMainOwnerUsername } from "@/lib/owners";
import type { SessionPayload } from "@/lib/session";

/**
 * The "export ALL users" CSV button on /users is now OWNER-gated (was
 * `motha`-only by username). It dumps every user's email + total deposited in
 * one shot (raw PII, no staff-exclusion), so access stays deliberately tighter
 * than the capability-gated `/api/users/export` dialog any admin can use — only
 * an owner may generate this export.
 */

/**
 * Throwing server-side gate for the export Server Action. THROWS (does not
 * redirect) — the caller is an RPC-style Server Action returning a CSV string,
 * so an error result is the correct control flow. NEVER returns the export data
 * to a non-owner. `session.isOwner` is read DB-fresh by verifySession; the
 * permanent `motha` username is owner regardless.
 */
export async function requireUsersExportAdmin(): Promise<
  SessionPayload & { username: string }
> {
  const session = await verifySession();
  if (!sessionIsOwner(session)) {
    throw new Error("Not permitted.");
  }
  return { ...session, username: session.username };
}

/**
 * Non-throwing owner check for conditionally rendering the button. Purely
 * cosmetic — `requireUsersExportAdmin` above is the real security boundary.
 */
async function canExportAllUsers(userId: string): Promise<boolean> {
  return isOwnerById(userId);
}

/**
 * Pure username predicate for callers that already hold the live `admin_users`
 * row (e.g. the consolidated /users page-gate read). Can only confirm the
 * permanent MAIN owner from a bare username — row-aware callers should OR this
 * with the row's `is_owner` flag (see {@link isUsersExportOwnerRow}). Purely
 * cosmetic; the throwing gate stays the real boundary. Callers must AND with
 * `is_active`.
 */
function isUsersExportAdminUsername(username: string): boolean {
  return isMainOwnerUsername(username);
}

/**
 * Owner check from an already-fetched admin row. Returns true for the permanent
 * main owner or any flagged owner. Callers must AND with `is_active`.
 */
function isUsersExportOwnerRow(
  username: string | null | undefined,
  isOwner: boolean | null | undefined,
): boolean {
  return isMainOwnerUsername(username) || isOwner === true;
}
