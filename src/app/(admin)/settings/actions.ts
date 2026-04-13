"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

/**
 * Notify the main backend to reload its cached site config.
 * Uses the same env vars as security/actions.ts (BACKEND_API_URL + BACKEND_API_KEY),
 * plus BACKEND_BYPASS_SECRET if available.
 */
async function refreshSiteConfig() {
  const headers: Record<string, string> = {
    "x-api-key": process.env.BACKEND_API_KEY!,
  };
  if (process.env.BACKEND_BYPASS_SECRET) {
    headers["x-bypass-secret"] = process.env.BACKEND_BYPASS_SECRET;
  }

  try {
    const res = await fetch(
      `${process.env.BACKEND_API_URL}/admin/refresh_site_config`,
      { method: "POST", headers },
    );
    if (!res.ok) {
      console.error("[refreshSiteConfig]", res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("[refreshSiteConfig] Failed:", e);
  }
}

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
