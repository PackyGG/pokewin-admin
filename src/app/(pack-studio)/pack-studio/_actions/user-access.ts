"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { verifySession, sessionIsOwner } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { AdminSettingsTableMissingError } from "@/lib/admin-settings";
import {
  getPackStudioUserAccess,
  setPackStudioUserList,
} from "@/lib/pack-studio-access";

/**
 * Owner-only server actions for the per-username Pack Studio access overrides.
 *
 * SECURITY: these mutate who can enter Pack Studio, so the gate is OWNER-only
 * (mirrors `setCreatorHubAccessToggle`). `sessionIsOwner` reads the DB-fresh
 * `is_owner` flag verifySession put on the session (never trusts a
 * client-supplied identity) and we throw before any write for a non-owner.
 * Every change is audit-logged via `createAdminAuditEvent`.
 *
 * The two lists ride on top of the role default (`admin` role still passes
 * by default). The denylist always wins over the allowlist (and over the
 * admin-role default), so the toggle below can revoke an admin's access in
 * one click without touching their role. Owners can never be denied.
 */

/** Verified-owner check; returns the acting userId for audit stamping. */
async function requirePackStudioAccessOwner(): Promise<{ userId: string }> {
  const session = await verifySession();
  if (!sessionIsOwner(session)) {
    throw new Error("Not authorized to manage Pack Studio access.");
  }
  return { userId: session.userId };
}

function normalize(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Set the access state for one username. `enabled === true` adds the user to
 * the allowlist AND removes them from the denylist; `enabled === false` adds
 * them to the denylist AND removes them from the allowlist. The username
 * argument is normalized (trim + lowercase) to match how the parser stores
 * them, so callers can pass display-cased values safely.
 *
 * Returns a discriminated result rather than throwing for expected operator
 * errors (not authorized / table missing / unknown user) so the client can
 * show a clean sonner toast. Unexpected errors still propagate.
 */
export async function setPackStudioUserAccess(
  username: string,
  enabled: boolean,
): Promise<
  | { success: true; allowed: boolean }
  | { success: false; error: string }
> {
  let userId: string;
  try {
    ({ userId } = await requirePackStudioAccessOwner());
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  const normalized = normalize(username);
  if (!normalized) {
    return { success: false, error: "Username is required." };
  }

  // Confirm the target admin exists so we don't pollute the lists with typos.
  // Username lookup is case-insensitive against the stored value.
  let targetUserId: string | null = null;
  try {
    const row = (
      await adminDrizzle.execute<{
        id: string; is_owner: boolean; username: string;
      }>(sql`
        SELECT id, is_owner, username FROM admin_users
        WHERE LOWER(username) = ${normalized}
        LIMIT 1
      `)
    ).rows[0];
    if (!row) {
      return {
        success: false,
        error: `No admin found with username "${normalized}".`,
      };
    }
    targetUserId = row.id;
    // Belt and suspenders: refuse to write a denylist entry for an owner —
    // the gate already ignores it, but stashing it would be confusing.
    if (!enabled && row.is_owner) {
      return {
        success: false,
        error: "Owners cannot be denied Pack Studio access.",
      };
    }
  } catch (err) {
    // Any unexpected DB read failure here is a real bug (not a
    // table-missing scenario), so propagate it.
    throw err;
  }

  try {
    const before = await getPackStudioUserAccess();
    const allowedBefore = before.allowlist.includes(normalized);
    const deniedBefore = before.denylist.includes(normalized);

    // Build the next lists with the requested transition.
    const nextAllow = enabled
      ? Array.from(new Set([...before.allowlist, normalized]))
      : before.allowlist.filter((u) => u !== normalized);
    const nextDeny = enabled
      ? before.denylist.filter((u) => u !== normalized)
      : Array.from(new Set([...before.denylist, normalized]));

    const allowChanged =
      nextAllow.length !== before.allowlist.length ||
      nextAllow.some((u, i) => u !== before.allowlist[i]);
    const denyChanged =
      nextDeny.length !== before.denylist.length ||
      nextDeny.some((u, i) => u !== before.denylist[i]);

    if (!allowChanged && !denyChanged) {
      return { success: true, allowed: enabled };
    }

    if (allowChanged) {
      await setPackStudioUserList("allowlist", nextAllow, userId);
    }
    if (denyChanged) {
      await setPackStudioUserList("denylist", nextDeny, userId);
    }

    await createAdminAuditEvent({
      adminUserId: userId,
      eventType: "pack_studio_user_access_updated",
      targetUserId,
      metadata: {
        username: normalized,
        enabled,
        previous: { allowlisted: allowedBefore, denylisted: deniedBefore },
      },
    });

    // Sidebar portal visibility + the /pack-studio route guard both read
    // these lists in the layout — revalidate the whole layout tree.
    revalidatePath("/", "layout");
    revalidatePath("/pack-studio", "layout");
    return { success: true, allowed: enabled };
  } catch (err) {
    if (err instanceof AdminSettingsTableMissingError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
}
