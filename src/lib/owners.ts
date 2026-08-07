import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { verifySession } from "@/lib/dal";
import { MAIN_OWNER_USERNAME } from "@/lib/owners-shared";
import type { SessionPayload } from "@/lib/session";

/**
 * OWNER / ULTRA-ADMIN tier (central source of truth).
 *
 * An "owner" is a formal flag that sits ABOVE the regular admin role and is
 * orthogonal to the RoleV2 permission model. An owner:
 *   • bypasses EVERY page + capability check (exactly like the `admin` role —
 *     see the bypass in `requirePageAccess` / `requireCapability`), AND
 *   • passes every owner-only surface (Salaries, Excluded Users, the re-price
 *     tool, the creator-hub-access toggles, admin balance-adjustment
 *     visibility, the Insights section, the export-all-users button, …).
 *
 * Two roots feed the decision:
 *   1. The permanent ROOT owner `motha` — hard-coded here, can never be removed
 *      or demoted. motha is owner even if the DB row says otherwise.
 *   2. Any admin whose `admin_users.is_owner` column is true (toggled by the
 *      main owner via the owner-management UI). Read DB-fresh in
 *      `verifySession` and surfaced as `session.isOwner` (NOT baked into the
 *      JWT — same freshness contract as `role` / `is_active`).
 *
 * Only the MAIN owner (motha) can add/remove owners; other owners get full
 * access but cannot manage the owner list — see `isMainOwner` /
 * `requireMainOwner`.
 *
 * Everything that used to be hard-coded to the `motha` username now routes
 * through these helpers so the owner set is a managed flag, not eleven
 * scattered string literals.
 */

/**
 * The permanent ROOT / MAIN owner username. Hard-coded, lowercase. This account
 * is ALWAYS an owner (DB-independent) and is the ONLY account that can manage
 * the owner list. Matches the case-insensitive `motha` checks the old
 * per-feature gates used.
 *
 * DEFINED in `src/lib/owners-shared.ts` (edge-safe: middleware and
 * `app-hosts.ts` import it from there because this module pulls in the
 * ADMIN-DB client) and re-exported here so server-side callers keep one
 * canonical import path.
 */
export { MAIN_OWNER_USERNAME } from "@/lib/owners-shared";

function normalize(username: string | null | undefined): string {
  return (username ?? "").trim().toLowerCase();
}

/**
 * True if this session belongs to an owner. Pure + synchronous so it can be
 * reused verbatim by the sidebar (server-computed prop), route guards, and the
 * per-feature gates.
 *
 * `session.isOwner` is the DB-fresh flag `verifySession` reads from
 * `admin_users.is_owner`; the `motha` username check is the permanent root
 * bypass that never depends on the DB.
 */
export function isOwner(
  session: Pick<SessionPayload, "username" | "isOwner">,
): boolean {
  return normalize(session.username) === MAIN_OWNER_USERNAME || session.isOwner === true;
}

/**
 * True only for the MAIN owner (motha) — the single account that can add or
 * remove owners. Every other owner sees everything but cannot manage the owner
 * list. DB-independent (username only) so the root can never lock itself out.
 */
export function isMainOwner(session: Pick<SessionPayload, "username">): boolean {
  return normalize(session.username) === MAIN_OWNER_USERNAME;
}

/**
 * Non-owner usernames additionally trusted to SEE admin-only markings — the
 * "marked by admin" / excluded-user flags on leaderboard standings, and any
 * other surface that reveals who an admin has flagged. Owners always see them;
 * this list adds specific trusted operators on top (owner directive: demee).
 *
 * Hard-coded + lowercased like {@link MAIN_OWNER_USERNAME} so a DB blip can
 * never silently widen who can see the flags. Kept SEPARATE from the
 * pack-studio operator allowlist on purpose: this is a different capability
 * (seeing fraud markings, not running retunes), so the two must not drift into
 * each other — removing someone from one must not silently change the other.
 */
const ADMIN_MARKING_VIEWER_USERNAMES: readonly string[] = ["demee"];

/**
 * True iff this session may SEE admin-only markings (the "marked by admin"
 * excluded-user badge on leaderboards + the marked-prize fraud-exposure pill).
 * Owners + the trusted-viewer allowlist above; every other admin/support sees a
 * clean leaderboard with no marking at all.
 *
 * The Excluded Users management page is already owner-only (`requireOwner`);
 * this closes the same information leaking through the leaderboard badges,
 * which every admin could previously read.
 */
export function canSeeAdminMarking(
  session: Pick<SessionPayload, "username" | "isOwner">,
): boolean {
  return (
    isOwner(session) ||
    ADMIN_MARKING_VIEWER_USERNAMES.includes(normalize(session.username))
  );
}

/** Lowercased predicate variants for callers that already hold the username. */
export function isMainOwnerUsername(username: string | null | undefined): boolean {
  return normalize(username) === MAIN_OWNER_USERNAME;
}

/**
 * Missing-column-safe DB read of `admin_users.is_owner` for a given admin id. The column
 * may ship ahead of code on some deploy (or behind, on an un-migrated dev DB) —
 * a missing column / any read failure degrades to `false` (fail-closed: a blip
 * can only ever HIDE owner power from a non-root admin, never grant it). The
 * permanent `motha` bypass does NOT depend on this read.
 */
export async function readIsOwnerColumn(adminUserId: string): Promise<boolean> {
  try {
    const [row] = await adminDrizzle
      .select({ is_owner: admin_users.is_owner })
      .from(admin_users)
      .where(and(eq(admin_users.id, adminUserId), eq(admin_users.is_active, true)))
      .limit(1);
    return row?.is_owner === true;
  } catch {
    // 42703 (column missing) or any transient fault → fail-closed.
    return false;
  }
}

/**
 * Non-throwing owner check by admin id (for conditional UI bits that only hold
 * the id). Resolves the username + the `is_owner` column, fail-closed on error.
 * The permanent `motha` username is owner regardless of the column.
 */
export async function isOwnerById(adminUserId: string): Promise<boolean> {
  try {
    const [row] = await adminDrizzle
      .select({
        username: admin_users.username,
        is_owner: admin_users.is_owner,
      })
      .from(admin_users)
      .where(and(eq(admin_users.id, adminUserId), eq(admin_users.is_active, true)))
      .limit(1);
    if (!row) return false;
    return isMainOwnerUsername(row.username) || row.is_owner === true;
  } catch {
    return false;
  }
}

/**
 * Throwing server-side gate for owner-only routes. Verifies the session, then
 * redirects to /dashboard if the viewer is not an owner — mirroring exactly how
 * `requireExcludedUsersAccess` (the gate this replaces) redirected. Uses a
 * static destination (`/dashboard`) so it is next.config-safe and never hits
 * the in-render dynamic-redirect crash.
 *
 * Returns the session augmented with the verified username so call sites that
 * relied on the old `SessionPayload & { username }` shape keep compiling.
 */
export async function requireOwner(): Promise<SessionPayload & { username: string }> {
  const session = await verifySession();
  if (!isOwner(session)) {
    redirect("/dashboard");
  }
  return { ...session, username: session.username };
}

/**
 * Throwing server-side gate for owner-MANAGEMENT routes/actions — only the main
 * owner (motha) passes. Other owners are redirected to /dashboard. Same
 * static-destination + augmented-return contract as `requireOwner`.
 */
export async function requireMainOwner(): Promise<SessionPayload & { username: string }> {
  const session = await verifySession();
  if (!isMainOwner(session)) {
    redirect("/dashboard");
  }
  return { ...session, username: session.username };
}
