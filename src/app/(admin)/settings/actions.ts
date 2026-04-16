"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { refreshSiteConfig } from "@/lib/refresh-site-config";

export async function upsertVaultLockTime(
  id: string | null,
  hours: number,
  label: string
) {
  const session = await requireAdmin();

  if (hours <= 0) throw new Error("Hours must be positive");
  if (!label.trim()) throw new Error("Label is required");

  if (id) {
    await db.vault_lock_times.update({
      where: { id },
      data: { hours, label: label.trim() },
    });
  } else {
    await db.vault_lock_times.create({
      data: { hours, label: label.trim() },
    });
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "vault_lock_time_updated",
    metadata: { id, hours, label },
  });

  revalidatePath("/settings");
}

export async function deleteVaultLockTime(id: string) {
  const session = await requireAdmin();

  await db.vault_lock_times.delete({ where: { id } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "vault_lock_time_deleted",
    metadata: { id },
  });

  revalidatePath("/settings");
}

export async function updateCountryRestrictionArray(
  countryCode: string,
  field: string,
  values: string[]
) {
  const session = await requireAdmin();

  const validFields = [
    "locked_deposits_crypto",
    "locked_deposits_fiat",
    "locked_withdrawals_crypto",
  ];
  if (!validFields.includes(field)) throw new Error("Invalid field");

  await db.country_restrictions.update({
    where: { country_code: countryCode },
    data: { [field]: values },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: { country_code: countryCode, field, values },
  });

  await refreshSiteConfig();
  revalidatePath("/settings");
}

/**
 * Turn maintenance mode on packy.gg on/off. Writes to site_config keys:
 *   - maintenance_mode    ("true" | "false")
 *   - maintenance_message (free-text shown to users during maintenance)
 *
 * The game backend reads these keys on every public request and returns
 * a maintenance response when enabled. refreshSiteConfig() pings the
 * backend so its in-memory cache picks up the new values immediately
 * instead of waiting for the next periodic refresh.
 *
 * Returns errors as values so the client toast shows a real message
 * instead of the RSC-masked "Server Components render" error.
 */
export async function setMaintenanceMode(
  enabled: boolean,
  message: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAdmin();

  const trimmedMessage = message.trim();

  try {
    await db.$transaction([
      db.site_config.upsert({
        where: { key: "maintenance_mode" },
        update: { value: enabled ? "true" : "false" },
        create: {
          key: "maintenance_mode",
          value: enabled ? "true" : "false",
          description: "When 'true', packy.gg blocks non-admin users and shows the maintenance screen.",
        },
      }),
      db.site_config.upsert({
        where: { key: "maintenance_message" },
        update: { value: trimmedMessage },
        create: {
          key: "maintenance_message",
          value: trimmedMessage,
          description: "Message shown to users on the maintenance screen.",
        },
      }),
    ]);
  } catch (err) {
    console.error("[setMaintenanceMode] DB write failed:", err);
    const errMsg = err instanceof Error ? err.message : "Unknown DB error";
    return { success: false, error: `Failed to update maintenance mode: ${errMsg}` };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "maintenance_mode_updated",
    metadata: { enabled, message: trimmedMessage },
  });

  // Non-blocking: tell the backend to reload its config cache. If it fails
  // the DB value still wins on the next periodic refresh — we log it.
  await refreshSiteConfig();

  revalidatePath("/settings");
  return { success: true };
}

export async function toggleCountryRestriction(
  countryCode: string,
  field: string,
  value: boolean
) {
  const session = await requireAdmin();

  const validFields = [
    "physical_withdrawal",
    "digital_withdrawal",
    "gift_card_deposit",
    "promo_code_deposit",
    "blocked",
  ];
  if (!validFields.includes(field)) throw new Error("Invalid field");

  await db.country_restrictions.update({
    where: { country_code: countryCode },
    data: { [field]: value },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: { country_code: countryCode, field, value },
  });

  await refreshSiteConfig();
  revalidatePath("/settings");
}
