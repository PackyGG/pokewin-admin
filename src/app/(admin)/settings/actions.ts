"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

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

  revalidatePath("/settings");
}
