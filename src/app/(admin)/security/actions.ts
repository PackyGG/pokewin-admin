"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";

import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { getDrizzleDb } from "@/lib/db";
import { site_config } from "@/lib/db-schema/main/schema";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { refreshSiteConfig } from "@/lib/refresh-site-config";

export async function upsertSiteConfig(
  key: string,
  value: string,
  description: string | null
) {
  const db = await getDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_upsert_site_config", "update site config");

  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("Key is required");

  await db
    .insert(site_config)
    .values({ key: trimmedKey, value, description })
    .onConflictDoUpdate({
      target: site_config.key,
      set: { value, description, updated_at: new Date().toISOString() },
    });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "site_config_updated",
    metadata: { key: trimmedKey, value, description },
  });

  await refreshSiteConfig();

  revalidatePath("/security");
  revalidateTag(SECURITY_CACHE_TAG);
}

export async function deleteSiteConfig(key: string) {
  const db = await getDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_site_config", "delete site config");

  const deleted = await db
    .delete(site_config)
    .where(eq(site_config.key, key))
    .returning({ key: site_config.key });
  if (!deleted[0]) throw new Error("Site config not found");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "site_config_deleted",
    metadata: { key },
  });

  await refreshSiteConfig();

  revalidatePath("/security");
  revalidateTag(SECURITY_CACHE_TAG);
}
