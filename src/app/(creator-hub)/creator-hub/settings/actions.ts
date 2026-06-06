"use server";

import { revalidatePath } from "next/cache";

import { verifySession } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { AdminSettingsTableMissingError } from "@/lib/admin-settings";
import {
  canAccessCreatorHub,
  getCreatorHubAccessSettings,
} from "@/lib/creator-hub-access";
import {
  integrationKeyInputSchema,
  setIntegrationKey,
  clearIntegrationKey,
  getIntegrationKeyRows,
  INTEGRATION_KEY_META,
  type IntegrationKeyId,
  type IntegrationKeyRowData,
} from "@/lib/integration-settings";

/**
 * Server actions for the Creator-Hub integration API-key settings.
 *
 * SECURITY (this is the sensitive surface — it writes third-party secrets):
 *  - Access is gated to the SAME rule that guards the whole Creator Hub
 *    (`canAccessCreatorHub`): the founder account `motha`, or a viewer whose
 *    effective role has its ADMIN-DB toggle enabled. We re-verify the session
 *    server-side and re-read the live role/active flag from the ADMIN DB —
 *    never trusting any client-supplied identity.
 *  - The raw key is accepted, validated, and written to the ADMIN DB only.
 *    NOTHING here ever returns the stored secret to the client: every result
 *    carries only the masked {@link IntegrationKeyRowData} list.
 *  - Every change is audit-logged via `createAdminAuditEvent` with the key id
 *    (never the value).
 */

type ActionResult =
  | { success: true; statuses: IntegrationKeyRowData[] }
  | { success: false; error: string };

/**
 * Re-verify + authorize the caller against the Creator-Hub access rule and
 * return the acting admin's id for audit stamping. Throws (caught at the call
 * site → toast) when the caller can't access the Hub or the account is gone /
 * inactive. Mirrors the layout gate so the page and its mutations can't drift.
 */
async function requireCreatorHubAccess(): Promise<{ userId: string }> {
  const session = await verifySession();

  // Re-read the live account from the ADMIN DB by the verified userId so a
  // deactivated account (or one whose username changed) can't slip through on
  // a stale JWT. We rebuild the access decision from the DB-fresh username +
  // the session's effective roles.
  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });
  if (!user?.is_active) {
    throw new Error("Not authorized to manage integration keys.");
  }

  const settings = await getCreatorHubAccessSettings();
  const allowed = canAccessCreatorHub(
    {
      username: user.username,
      role: session.role,
      roles: session.roles,
    },
    settings,
  );
  if (!allowed) {
    throw new Error("Not authorized to manage integration keys.");
  }
  return { userId: session.userId };
}

/**
 * Save (create or replace) one integration API key. The new raw value is
 * written to the ADMIN DB; the response carries only the refreshed masked
 * statuses so the UI can update without the secret ever crossing the wire.
 */
export async function saveIntegrationKey(
  id: string,
  value: string,
): Promise<ActionResult> {
  let userId: string;
  try {
    ({ userId } = await requireCreatorHubAccess());
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  const parsed = integrationKeyInputSchema.safeParse({ id, value });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid key.",
    };
  }

  const keyId = parsed.data.id as IntegrationKeyId;

  try {
    await setIntegrationKey(keyId, parsed.data.value, userId);

    await createAdminAuditEvent({
      adminUserId: userId,
      eventType: "integration_api_key_updated",
      metadata: {
        // Key id + provider only — NEVER the secret value.
        key: keyId,
        provider: INTEGRATION_KEY_META[keyId].provider,
        action: "set",
      },
    });

    revalidatePath("/creator-hub/settings");
    return { success: true, statuses: await getIntegrationKeyRows() };
  } catch (err) {
    if (err instanceof AdminSettingsTableMissingError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
}

/**
 * Clear a stored integration API key (reverts it to "not set"). Audit-logged.
 * Returns the refreshed masked statuses.
 */
export async function removeIntegrationKey(id: string): Promise<ActionResult> {
  let userId: string;
  try {
    ({ userId } = await requireCreatorHubAccess());
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  // Reuse the schema's id check only (value isn't relevant to a clear).
  const idCheck = integrationKeyInputSchema.shape.id.safeParse(id);
  if (!idCheck.success) {
    return {
      success: false,
      error: idCheck.error.issues[0]?.message ?? "Unknown integration key.",
    };
  }
  const keyId = idCheck.data as IntegrationKeyId;

  try {
    await clearIntegrationKey(keyId, userId);

    await createAdminAuditEvent({
      adminUserId: userId,
      eventType: "integration_api_key_updated",
      metadata: {
        key: keyId,
        provider: INTEGRATION_KEY_META[keyId].provider,
        action: "clear",
      },
    });

    revalidatePath("/creator-hub/settings");
    return { success: true, statuses: await getIntegrationKeyRows() };
  } catch (err) {
    if (err instanceof AdminSettingsTableMissingError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
}
