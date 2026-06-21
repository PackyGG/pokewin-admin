"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { refreshSiteConfig } from "@/lib/refresh-site-config";
import { WITHDRAWALS_ENABLED_KEY } from "@/lib/queries/physical-withdrawals";
import { ok, fail, type ServerActionResult } from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";

/**
 * Global withdrawals master switch — writes `site_config.withdrawals_enabled`
 * on the MAIN/PROD game DB (operator-triggered runtime write, same pattern as
 * the /security generic site_config editor) and pings the backend to reload
 * its cached config. Disabling this turns off ALL withdrawal methods (crypto
 * + balance + physical), not just physical — the toggle copy makes that clear.
 *
 * Gated by `__can_upsert_site_config` (the same capability that protects the
 * /security key/value editor) and audited.
 */
export async function setWithdrawalsEnabled(
  enabled: boolean,
): Promise<ServerActionResult<{ enabled: boolean }>> {
  const session = await requirePageAccess("/physical");
  try {
    await requireCapability(
      session,
      "__can_upsert_site_config",
      "toggle withdrawals",
    );
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

  const db = await getDb();
  const value = enabled ? "true" : "false";
  try {
    await db.site_config.upsert({
      where: { key: WITHDRAWALS_ENABLED_KEY },
      update: { value },
      create: {
        key: WITHDRAWALS_ENABLED_KEY,
        value,
        description: "Turn off all withdrawals if turned off",
      },
    });
  } catch (err) {
    logError("physical.setWithdrawalsEnabled", "site_config upsert failed", err);
    return fail(
      "Couldn't update the withdrawals switch — please try again.",
      "DB_FAILED",
    );
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "site_config_updated",
    metadata: { key: WITHDRAWALS_ENABLED_KEY, value, surface: "physical" },
  });

  await refreshSiteConfig();
  revalidatePath("/physical");
  return ok({ enabled });
}

/**
 * Bulk physical-withdrawal availability — flips
 * `country_restrictions.physical_withdrawal` for EVERY country in one write
 * (the per-country grain stays editable on /system/geo-blocking). Same
 * MAIN-DB runtime-write + backend-refresh pattern as the geo-blocking
 * toggles, gated by `__can_toggle_country_restriction` and audited.
 */
export async function setPhysicalWithdrawalAllCountries(
  enabled: boolean,
): Promise<ServerActionResult<{ enabled: boolean; affected: number }>> {
  const session = await requirePageAccess("/physical");
  try {
    await requireCapability(
      session,
      "__can_toggle_country_restriction",
      "toggle physical withdrawals",
    );
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

  const db = await getDb();
  let affected = 0;
  try {
    const res = await db.country_restrictions.updateMany({
      data: { physical_withdrawal: enabled },
    });
    affected = res.count;
  } catch (err) {
    logError(
      "physical.setPhysicalWithdrawalAllCountries",
      "country_restrictions updateMany failed",
      err,
    );
    return fail(
      "Couldn't update physical-withdrawal availability — please try again.",
      "DB_FAILED",
    );
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: {
      field: "physical_withdrawal",
      value: enabled,
      scope: "all_countries",
      affected,
    },
  });

  await refreshSiteConfig();
  revalidatePath("/physical");
  return ok({ enabled, affected });
}
