import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
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
 * Batched sibling of {@link getAdminSetting}: reads many keys in ONE round trip.
 *
 * The admin pool is intentionally tiny on Vercel (`max: 2`), so N single-row
 * `getAdminSetting()` calls inside a `Promise.all` do not actually run in
 * parallel — they queue behind each other AND starve the page's own reads of a
 * connection. Use this whenever a caller needs more than one key at a time.
 *
 * Degradation matches `getAdminSetting()` exactly: a missing `admin_settings`
 * table yields an EMPTY map (every key reads as unset) rather than throwing, so
 * a pre-migration DB behaves as if nothing were configured. Keys with a NULL
 * value are likewise omitted, which is what a `null` return meant before.
 * Every other error is rethrown so fail-closed callers still see the failure.
 */
export async function getAdminSettings(
  keys: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  try {
    const result = await adminDrizzle.execute<{
      key: string;
      value: string | null;
    }>(sql`
      SELECT key, value FROM admin_settings
      WHERE key = ANY(${pgArrayParam([...keys])}::text[])
    `);
    for (const row of result.rows) {
      if (typeof row.value === "string") out.set(row.key, row.value);
    }
    return out;
  } catch (err) {
    if (isMissingTableError(err)) return out;
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
