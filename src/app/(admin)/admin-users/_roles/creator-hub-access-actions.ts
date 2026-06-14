"use server";

import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { AdminSettingsTableMissingError } from "@/lib/admin-settings";
import {
  CREATOR_HUB_TOGGLE_ROLES,
  type CreatorHubToggleRole,
  getCreatorHubAccessSettings,
  setCreatorHubAccessSetting,
  type CreatorHubAccessSettings,
} from "@/lib/creator-hub-access";

/**
 * Server actions for the founder-controlled Creator-Hub access toggles.
 *
 * SECURITY: these mutate who can enter the Creator Hub, so the gate is the
 * tightest one in the app — ONLY the `motha` account. We resolve the
 * username from the ADMIN DB by the verified session's userId (never trust
 * a client-supplied identity) and throw before any write if it isn't motha.
 * Every change is audit-logged via `createAdminAuditEvent`.
 */
const ALLOWED_USERNAMES = ["motha"] as const;

function isAllowed(username: string): boolean {
  const lower = username.toLowerCase();
  return ALLOWED_USERNAMES.some((u) => u === lower);
}

/**
 * Resolve + authorize the acting admin as the Creator-Hub access owner.
 * Returns the userId for audit stamping. Throws (caught at the call site →
 * toast) when the caller isn't the founder account.
 */
async function requireCreatorHubAccessOwner(): Promise<{ userId: string }> {
  const session = await verifySession();
  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });
  if (!user?.is_active || !isAllowed(user.username)) {
    throw new Error("Not authorized to manage Creator Hub access.");
  }
  return { userId: session.userId };
}

function isToggleRole(role: string): role is CreatorHubToggleRole {
  return (CREATOR_HUB_TOGGLE_ROLES as readonly string[]).includes(role);
}

/**
 * Flip one per-role Creator-Hub access toggle on or off.
 *
 * Returns a discriminated result rather than throwing for expected operator
 * errors (not authorized / table missing) so the client can show a clean
 * sonner toast; unexpected errors still propagate. Re-reads current state
 * before writing so the audit log records the real before→after.
 */
export async function setCreatorHubAccessToggle(
  role: string,
  enabled: boolean,
): Promise<{ success: true } | { success: false; error: string }> {
  let userId: string;
  try {
    ({ userId } = await requireCreatorHubAccessOwner());
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  if (!isToggleRole(role)) {
    return { success: false, error: "Unknown Creator Hub access role." };
  }

  try {
    const before = await getCreatorHubAccessSettings();
    // No-op writes still record an audit row would be noise; skip if
    // unchanged so the log only reflects real state transitions.
    if (before[role] === enabled) {
      return { success: true };
    }

    await setCreatorHubAccessSetting(role, enabled, userId);

    await createAdminAuditEvent({
      adminUserId: userId,
      eventType: "creator_hub_access_toggle_updated",
      metadata: {
        role,
        enabled,
        previous: before[role],
      },
    });

    // The portal button + route guard read these settings in the layout,
    // so revalidate the whole layout tree plus the Admins & Access page itself.
    revalidatePath("/admin-users");
    revalidatePath("/", "layout");
    return { success: true };
  } catch (err) {
    if (err instanceof AdminSettingsTableMissingError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
}

/**
 * Read the current per-role toggle state for rendering the card. Owner-only
 * (matches the mutation gate) — a non-owner never sees this card, but we
 * authorize on read too so the data can't leak via a stray import.
 */
export async function getCreatorHubAccessToggles(): Promise<CreatorHubAccessSettings> {
  await requireCreatorHubAccessOwner();
  return getCreatorHubAccessSettings();
}
