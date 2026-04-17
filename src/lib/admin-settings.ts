import { adminDb } from "@/lib/admin-db";

/**
 * Known admin-panel setting keys. Extend this when adding new key/value
 * settings — callers should import from here rather than hardcoding
 * strings so refactors stay mechanical.
 */
export const SETTINGS_KEYS = {
  /** user.id of the real user account that owns all /creators/ads codes. */
  HOUSE_AFFILIATE_USER_ID: "house_affiliate_user_id",
} as const;

export async function getAdminSetting(key: string): Promise<string | null> {
  const row = await adminDb.admin_settings.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setAdminSetting(
  key: string,
  value: string,
  adminUserId: string,
): Promise<void> {
  await adminDb.admin_settings.upsert({
    where: { key },
    update: { value, updated_by: adminUserId },
    create: { key, value, updated_by: adminUserId },
  });
}
