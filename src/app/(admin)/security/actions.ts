"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

async function refreshSiteConfig() {
  const headers: Record<string, string> = {
    "x-api-key": process.env.BACKEND_API_KEY!,
  };
  const bypassSecret =
    process.env.CF_BYPASS_SECRET || process.env.BACKEND_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-bypass-secret"] = bypassSecret;
  }

  const res = await fetch(
    `${process.env.BACKEND_API_URL}/admin/refresh_site_config`,
    { method: "POST", headers },
  );

  if (!res.ok) {
    console.error("Failed to refresh site config:", await res.text().catch(() => "Unknown error"));
  }
}

export async function upsertSiteConfig(
  key: string,
  value: string,
  description: string | null
) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_upsert_site_config", "update site config");

  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("Key is required");

  await db.site_config.upsert({
    where: { key: trimmedKey },
    update: { value, description },
    create: { key: trimmedKey, value, description },
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
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_site_config", "delete site config");

  await db.site_config.delete({ where: { key } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "site_config_deleted",
    metadata: { key },
  });

  await refreshSiteConfig();

  revalidatePath("/security");
  revalidateTag(SECURITY_CACHE_TAG);
}
