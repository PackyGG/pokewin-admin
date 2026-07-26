import { ShieldCheck } from "lucide-react";
import { sql } from "drizzle-orm";

import { SectionHeading } from "@/components/modern-panels";
import { adminDrizzle } from "@/lib/admin-db";
import { getEffectiveRoles } from "@/lib/admin-roles";
import { getPackStudioUserAccess } from "@/lib/pack-studio-access";
import {
  PackStudioUserAccessCard,
  type PackStudioUserAccessRow,
} from "./pack-studio-user-access-card";

/**
 * Owner-only section on the Pack Studio overview page that surfaces the
 * per-username Pack Studio access overrides as a flippable list.
 *
 * Rendered ONLY for owner viewers (gated by the parent page). Renders the
 * union of:
 *   • every currently-tracked admin (allowlist ∪ denylist), so the owner
 *     can flip them back on/off; PLUS
 *   • a set of "interesting" admins to seed the UI — owners (always shown,
 *     read-only) and the explicitly-tracked username "demee" so the owner
 *     can revoke them in one click without typing the username.
 *
 * Server-only — no client-fetching, no function props cross the RSC boundary.
 */
export async function PackStudioUserAccessSection() {
  const [{ allowlist, denylist }, admins] = await Promise.all([
    getPackStudioUserAccess(),
    safeListInterestingAdmins(),
  ]);

  // De-dup: the user lists may carry usernames that don't currently match any
  // admin row (e.g. an account was renamed). We still render them so the
  // owner can clear stale entries from the lists.
  const lookup = new Map(admins.map((a) => [a.username.toLowerCase(), a]));
  const trackedUsernames = new Set<string>([
    ...allowlist,
    ...denylist,
    ...admins.map((a) => a.username.toLowerCase()),
  ]);

  const rows: PackStudioUserAccessRow[] = Array.from(trackedUsernames)
    .map((username): PackStudioUserAccessRow => {
      const admin = lookup.get(username);
      const hasAdminRole = admin
        ? getEffectiveRoles(admin.role, admin.roles).includes("admin")
        : false;
      return {
        username,
        displayName: admin?.displayName ?? username,
        hasAdminRole,
        isOwner: admin?.isOwner ?? false,
        allowlisted: allowlist.includes(username),
        denylisted: denylist.includes(username),
      };
    })
    // Owners first (always-on), then granted, then admin-default, then revoked,
    // then everything else; alphabetical within a group for stability.
    .sort((a, b) => {
      const rank = (r: PackStudioUserAccessRow) =>
        r.isOwner ? 0 : r.allowlisted ? 1 : r.hasAdminRole ? 2 : r.denylisted ? 3 : 4;
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.displayName.localeCompare(b.displayName);
    });

  return (
    <section className="space-y-3">
      <SectionHeading icon={ShieldCheck} title="Pack Studio access" />
      <PackStudioUserAccessCard rows={rows} />
    </section>
  );
}

type InterestingAdmin = {
  username: string;
  displayName: string;
  role: string;
  roles: string[] | null;
  isOwner: boolean;
};

/**
 * Resilient read of the admin rows we want to seed the toggle UI with: every
 * owner (so the owner can SEE every other owner is locked-on) plus an
 * explicitly-tracked username ("demee") that the request asked us to seed.
 *
 * On any error we degrade to an empty list so the section still renders (the
 * owner can still manage anyone via the username text the deny/allow lists
 * carry). Missing-column/table edge cases are swallowed.
 */
async function safeListInterestingAdmins(): Promise<InterestingAdmin[]> {
  try {
    const rows = (
      await adminDrizzle.execute<{
        username: string; display_username: string | null; role: string;
        roles: string[] | null; is_owner: boolean;
      }>(sql`
        SELECT username, display_username, role, roles, is_owner
        FROM admin_users
        WHERE is_active = true
          AND (is_owner = true OR LOWER(username) = 'demee')
      `)
    ).rows;
    return rows.map((row): InterestingAdmin => ({
      username: row.username,
      displayName: row.display_username?.trim() || row.username,
      role: row.role,
      roles: row.roles ?? null,
      isOwner: row.is_owner === true,
    }));
  } catch (err) {
    console.error(
      "[pack-studio-user-access] safeListInterestingAdmins failed:",
      err,
    );
    return [];
  }
}
