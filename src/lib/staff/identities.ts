import "server-only";

import { adminDb } from "@/lib/admin-db";

/**
 * Identity resolution for the antifraud/staff tables.
 *
 * The `staff_*` and `antifraud_*` tables carry bare `admin_user_id` UUIDs
 * (real FKs in the DB, but deliberately NOT modelled as Prisma relations — see
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
 * Batch-resolve admin identities by id. Unknown/deleted ids are simply absent
 * from the map — every call site renders a fallback for a missing entry rather
 * than failing, because an admin row can be deleted while their point events
 * and resolved reviews (correctly) live on.
 *
 * Resilient: any read failure degrades to an empty map so a transient admin-DB
 * fault costs the page its names, not its render.
 */
export async function loadAdminIdentities(
  ids: readonly (string | null | undefined)[],
): Promise<ReadonlyMap<string, AdminIdentity>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return EMPTY;

  try {
    const rows = await adminDb.admin_users.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        username: true,
        display_username: true,
        email: true,
        role: true,
        roles: true,
        is_active: true,
        profile_image_mime: true,
      },
    });

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          username: row.username,
          label: row.display_username ?? row.username,
          displayUsername: row.display_username ?? null,
          email: row.email,
          role: row.role,
          roles: row.roles.length > 0 ? [...row.roles] : [row.role],
          isActive: row.is_active,
          hasAvatar: Boolean(row.profile_image_mime),
        } satisfies AdminIdentity,
      ]),
    );
  } catch (err) {
    console.error("[antifraud] loadAdminIdentities failed:", err);
    return EMPTY;
  }
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
