"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { refreshSiteConfig } from "@/lib/refresh-site-config";
import { ok, fail, type ServerActionResult } from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";

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
