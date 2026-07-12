"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { invalidateCountryRestrictionsCache } from "@/lib/invalidate-country-restrictions-cache";

/**
 * Geo Blocking (formerly "Country Restrictions") server actions — relocated
 * verbatim from the old `/settings` page into the /system/geo-blocking
 * feature. The guards/capabilities are unchanged: requireAdmin + the same
 * `__can_update_country_restriction` / `__can_toggle_country_restriction`
 * capabilities. Only `revalidatePath` now targets /system/geo-blocking (the
 * new home) instead of the removed /settings route.
 *
 * Cache-invalidation note: these mutations write to `country_restrictions`,
 * which lives in its own Redis cache on the backend — NOT `site_config`.
 * They call `invalidateCountryRestrictionsCache()` (dedicated backend
 * endpoint) rather than `refreshSiteConfig()`, which was a mismatched-cache
 * bug fixed 2026-07-12 (see src/lib/refresh-site-config.ts for the
 * site_config sibling).
 *
 * These WRITE the MAIN/PROD game DB at runtime (operator-triggered). The
 * relocation does not change that behaviour.
 */
export async function updateCountryRestrictionArray(
  countryCode: string,
  field: string,
  values: string[]
) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_country_restriction", "update country restrictions");

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

  await invalidateCountryRestrictionsCache();
  revalidatePath("/system/geo-blocking");
}

export async function toggleCountryRestriction(
  countryCode: string,
  field: string,
  value: boolean
) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_toggle_country_restriction", "toggle country restrictions");

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

  await invalidateCountryRestrictionsCache();
  revalidatePath("/system/geo-blocking");
}
