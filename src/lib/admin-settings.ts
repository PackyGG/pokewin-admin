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

/** Marker thrown when the admin_settings table hasn't been migrated yet. */
export class AdminSettingsTableMissingError extends Error {
  constructor() {
    super(
      "admin_settings table is not yet available. Run the migration at " +
        "prisma/admin/migrations/20260418000000_add_admin_settings/ on the admin DB.",
    );
    this.name = "AdminSettingsTableMissingError";
  }
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Postgres "relation does not exist" + Prisma wrappers
  return (
    msg.includes("admin_settings") &&
    (msg.includes("does not exist") ||
      msg.includes("UndefinedTable") ||
      msg.includes("P2021") ||
      msg.includes("ColumnNotFound"))
  );
}

/**
 * Returns the setting value, or `null` if unset. If the `admin_settings`
 * table hasn't been migrated yet, returns `null` so callers can render a
 * pre-migration fallback UI instead of crashing the page.
 */
export async function getAdminSetting(key: string): Promise<string | null> {
  try {
    const row = await adminDb.admin_settings.findUnique({ where: { key } });
    return row?.value ?? null;
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

/**
 * Throws `AdminSettingsTableMissingError` if the table isn't migrated yet —
 * server actions should catch this and show a clear toast to the operator.
 */
export async function setAdminSetting(
  key: string,
  value: string,
  adminUserId: string,
): Promise<void> {
  try {
    await adminDb.admin_settings.upsert({
      where: { key },
      update: { value, updated_by: adminUserId },
      create: { key, value, updated_by: adminUserId },
    });
  } catch (err) {
    if (isMissingTableError(err)) throw new AdminSettingsTableMissingError();
    throw err;
  }
}
