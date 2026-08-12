import "server-only";

import { cache } from "react";
import { inArray } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";

/**
 * Identity resolution for antifraud records.
 *
 * The `antifraud_*` tables carry bare `admin_user_id` UUIDs
 * (real FKs in the DB, but deliberately not modeled as application relations — see
 * the schema note: modelling six relations would mean six disambiguated
 * back-relation fields on the `admin_users` hotspot model). So every surface
 * that needs a name or an avatar resolves it here, with ONE batched read per
 * page rather than a per-row lookup.
 */

export type AdminIdentity = {
  id: string;
  username: string;
  /** Preferred label: display name if set, else username. */
  label: string;
  displayUsername: string | null;
  email: string;
  role: string;
  roles: string[];
  isActive: boolean;
  hasAvatar: boolean;
};

const EMPTY: ReadonlyMap<string, AdminIdentity> = new Map();

/**
 * Per-request memo of ids that have already been resolved.
 *
 * "ONE batched read per page" above was aspirational, not actual: the reviews
 * route resolves the queue's assignees and openers, and then — for the case the
 * analyst has open — that case's assignee/opener/resolver plus up to 100 note
 * authors, and the open case is normally also in the queue. React `cache()`
 * gives one Map per server request, so the second call reads only the ids the
 * first one did not already fetch. A `null` entry is a real "no such admin row"
 * answer and is remembered too, so a deleted admin is not re-queried per call.
 *
 * Outside a request scope (a script, a non-React caller) React runs the factory
 * per call, which simply degrades to the previous one-read-per-call behaviour.
 */
const requestIdentityMemo = cache(
  (): Map<string, AdminIdentity | null> => new Map(),
);

/**
 * Batch-resolve admin identities by id. Unknown/deleted ids are simply absent
 * from the map — every call site renders a fallback for a missing entry rather
 * than failing, because an admin row can be deleted while their resolved
 * reviews correctly live on.
 *
 * Resilient: any read failure degrades to an empty map so a transient admin-DB
 * fault costs the page its names, not its render.
 */
export async function loadAdminIdentities(
  ids: readonly (string | null | undefined)[],
): Promise<ReadonlyMap<string, AdminIdentity>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return EMPTY;

  const memo = requestIdentityMemo();
  const missing = unique.filter((id) => !memo.has(id));

  if (missing.length > 0) {
    try {
      const rows = await adminDrizzle.select({
        id: admin_users.id, username: admin_users.username,
        display_username: admin_users.display_username, email: admin_users.email,
        role: admin_users.role, roles: admin_users.roles,
        is_active: admin_users.is_active,
        profile_image_mime: admin_users.profile_image_mime,
      }).from(admin_users).where(inArray(admin_users.id, missing));

      // Record the misses first so an id with no row is not re-queried; the
      // hits below overwrite their own entries.
      for (const id of missing) memo.set(id, null);
      for (const row of rows) {
        memo.set(row.id, {
          id: row.id,
          username: row.username,
          label: row.display_username ?? row.username,
          displayUsername: row.display_username ?? null,
          email: row.email,
          role: row.role,
          roles: row.roles.length > 0 ? [...row.roles] : [row.role],
          isActive: row.is_active,
          hasAvatar: Boolean(row.profile_image_mime),
        } satisfies AdminIdentity);
      }
    } catch (err) {
      console.error("[antifraud] loadAdminIdentities failed:", err);
      return EMPTY;
    }
  }

  const resolved = new Map<string, AdminIdentity>();
  for (const id of unique) {
    const identity = memo.get(id);
    if (identity) resolved.set(id, identity);
  }
  return resolved;
}

/**
 * A stable label for an id that may not resolve. Falls back to a short id stub
 * so a row never renders a blank actor column.
 */
export function identityLabel(
  identities: ReadonlyMap<string, AdminIdentity>,
  id: string | null | undefined,
  fallback = "System",
): string {
  if (!id) return fallback;
  return identities.get(id)?.label ?? id.slice(0, 8);
}
