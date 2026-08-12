import { cache } from "react";

import { adminDrizzle, sql } from "@/lib/drizzle";
import { withTimeout } from "@/lib/errors/safe-query";
import { isExcludedSearchOwnerRow } from "@/lib/excluded-users/search-gate";
import { logError } from "@/lib/errors/logger";
import type { SessionPayload } from "@/lib/session";

/**
 * Wall-clock bound for the gate row read.
 *
 * The try/catch below only catches a read that THROWS, never one that merely
 * hangs. This gate is consulted from inside the page's Suspense legs, so an
 * unbounded hang would pin the toolbar and the table indefinitely with no
 * failure state — the "page never finishes loading" shape. 4s is far above a
 * primary-key lookup on `admin_users` and degrades to the same fail-closed
 * flags a throw produces.
 */
const GATE_READ_TIMEOUT_MS = 4_000;

/**
 * The Admin DB half of the gate, deduped per request.
 *
 * Both /users Suspense legs (the toolbar's bulk-ban controls and the table's
 * excluded-search override) need these flags, and they render independently.
 * Keyed on the admin's id — a primitive — rather than the session object, so
 * the dedupe holds regardless of whether the two call sites happen to share
 * one object reference.
 */
const readGateRow = cache(
  async (
    adminUserId: string,
  ): Promise<{ username: string; is_active: boolean; is_owner: boolean } | undefined> =>
    withTimeout(
      async () =>
        (
          await adminDrizzle.execute<{
            username: string;
            is_active: boolean;
            is_owner: boolean;
          }>(sql`
            SELECT username, is_active, is_owner
            FROM admin_users
            WHERE id = ${adminUserId}::uuid
            LIMIT 1
          `)
        ).rows[0],
      GATE_READ_TIMEOUT_MS,
    ),
);

/**
 * Render-cosmetic gate flags for the /users list page, resolved from ONE
 * admin-DB read.
 *
 * The page previously issued three sequential, unguarded Admin DB lookups
 * before first paint (an `allowed_pages` read for the Deleted-users
 * button, an owner check for the Export-all button, and the
 * excluded-search check — the last two reading the SAME `admin_users` row
 * twice). Any Admin DB hiccup bypassed the page's safeQuery wrappers
 * entirely and crashed the whole view to error.tsx.
 *
 * Both button gates are gone with their buttons (owner, 2026-07-22), so
 * one flag is left — but the consolidated shape stays: it's still a single
 * `findUnique` on the session's admin row wrapped in try/catch, and it's
 * where any future /users render gate belongs. On failure it logs and
 * FAILS CLOSED — safe because the flag is render-cosmetic; the real
 * boundary is the excluded-search override re-verifying server-side.
 */
export type UsersPageGates = {
  /** Let an active search surface excluded (blacklisted) users. */
  includeExcludedInSearch: boolean;
  /**
   * Show the bulk-ban AND bulk-unban controls. ADMIN/OWNER ONLY — stricter
   * than the single-user ban, which is a support capability. Render-cosmetic:
   * `bulkBanFilteredUsers` / `bulkUnbanFilteredUsers` re-check this
   * server-side.
   */
  canBulkBan: boolean;
};

/** The slice of the session the gate resolution actually reads. */
export type UsersPageSession = Pick<
  SessionPayload,
  "userId" | "role" | "roles" | "isOwner"
>;

export async function getUsersPageGates(
  session: UsersPageSession,
): Promise<UsersPageGates> {
  // Read off the session, which dal.ts already refreshed from the DB — no
  // extra round-trip just to learn the caller is an admin.
  const canBulkBan =
    (session.roles?.includes("admin") ?? session.role === "admin") ||
    Boolean(session.isOwner);
  try {
    const row = await readGateRow(session.userId);
    const active = Boolean(row?.is_active);
    return {
      includeExcludedInSearch:
        active && isExcludedSearchOwnerRow(row?.username ?? "", row?.is_owner ?? false),
      canBulkBan,
    };
  } catch (err) {
    logError(
      "users.gates",
      "admin gate read failed — failing closed on render flags",
      err,
    );
    return {
      includeExcludedInSearch: false,
      // Fails closed like the flag above.
      canBulkBan: false,
    };
  }
}
