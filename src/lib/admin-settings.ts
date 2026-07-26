import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import {
  isPostgresError,
  postgresErrorMessages,
} from "@/lib/postgres-errors";

/**
 * Known admin-panel setting keys. Extend this when adding new key/value
 * settings — callers should import from here rather than hardcoding
 * strings so refactors stay mechanical.
 */
export const SETTINGS_KEYS = {
  /** user.id of the real user account that owns all /creators/ads codes. */
  HOUSE_AFFILIATE_USER_ID: "house_affiliate_user_id",
  /**
   * Prefix for the per-role Creator-Hub access toggles. The concrete key is
   * `creator_hub_access_<role>_enabled` (e.g.
   * `creator_hub_access_admin_enabled`). Built via
   * `creatorHubToggleKey()` in `@/lib/creator-hub-access` — import that
   * helper rather than concatenating the string by hand.
   */
  CREATOR_HUB_ACCESS_PREFIX: "creator_hub_access_",
} as const;

/** Marker thrown when the admin_settings table hasn't been migrated yet. */
export class AdminSettingsTableMissingError extends Error {
  constructor() {
    super(
      "admin_settings is not available. Apply the reviewed Admin DB migration before retrying.",
    );
    this.name = "AdminSettingsTableMissingError";
  }
}

function isMissingTableError(err: unknown): boolean {
  if (isPostgresError(err, "42P01")) return true;
  const msg = postgresErrorMessages(err);
  return (
    msg.includes("admin_settings") &&
    (msg.includes("does not exist") ||
      msg.includes("UndefinedTable") ||
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
    const result = await adminDrizzle.execute<{ value: string }>(sql`
      SELECT value FROM admin_settings WHERE key = ${key} LIMIT 1
    `);
    return result.rows[0]?.value ?? null;
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
    await adminDrizzle.execute(sql`
      INSERT INTO admin_settings (key, value, updated_by)
      VALUES (${key}, ${value}, ${adminUserId}::uuid)
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
    `);
  } catch (err) {
    if (isMissingTableError(err)) throw new AdminSettingsTableMissingError();
    throw err;
  }
}
