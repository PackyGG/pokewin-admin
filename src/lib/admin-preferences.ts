import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import {
  isPostgresError,
  postgresErrorMessages,
} from "@/lib/postgres-errors";

// Pure types + constants + validators moved to ./admin-preferences-types
// so client components can import without pulling database drivers into
// the browser bundle. Re-exported here for backward compat with
// server-side callers.
export {
  
  THEME_VALUES,
  DATE_FORMAT_VALUES,
  isValidTimezone,
  type AdminPreferences,
} from "./admin-preferences-types";

import {
  DEFAULT_PREFERENCES,
  THEME_VALUES,
  DATE_FORMAT_VALUES,
  isValidTimezone,
  type AdminPreferences,
} from "./admin-preferences-types";

// ---- Parsing ------------------------------------------------------------

/**
 * Validate a raw JSONB blob read out of the DB into a typed
 * `AdminPreferences`. Defaults are applied for missing fields; unknown
 * extra fields are ignored. Never throws — any malformed input yields
 * the defaults so a corrupted preferences row can't brick the UI.
 */
function parsePreferences(raw: unknown): AdminPreferences {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFERENCES };
  const obj = raw as Record<string, unknown>;

  // Derive the whitelist from THEME_VALUES (single source) so new themes
  // like "grailed" survive a round-trip instead of being reset to default.
  const theme: AdminPreferences["theme"] =
    typeof obj.theme === "string" &&
    (THEME_VALUES as readonly string[]).includes(obj.theme)
      ? (obj.theme as AdminPreferences["theme"])
      : DEFAULT_PREFERENCES.theme;

  let timezone: string | null = DEFAULT_PREFERENCES.timezone;
  if (obj.timezone === null) {
    timezone = null;
  } else if (typeof obj.timezone === "string" && isValidTimezone(obj.timezone)) {
    timezone = obj.timezone;
  }

  const dateFormat: AdminPreferences["dateFormat"] =
    obj.dateFormat === "MMM d, yyyy" ||
    obj.dateFormat === "dd/MM/yyyy" ||
    obj.dateFormat === "yyyy-MM-dd"
      ? obj.dateFormat
      : undefined;

  return {
    theme,
    timezone,
    ...(dateFormat ? { dateFormat } : {}),
  };
}

// `isValidTimezone` now lives in ./admin-preferences-types and is
// re-exported above.

// ---- Graceful pre-migration handling ------------------------------------

// Mirrors the admin-settings.ts pattern. If the `preferences` column
// hasn't been migrated yet we want to return DEFAULT_PREFERENCES instead
// of blowing up the layout — callers can render a pre-migration banner
// if needed, and the rest of the UI falls back to browser-detected zone.
function isMissingColumnError(err: unknown): boolean {
  return (
    isPostgresError(err, "42703") ||
    /column .* does not exist/i.test(postgresErrorMessages(err))
  );
}

// ---- Reads / writes ------------------------------------------------------

/**
 * Returns the admin's parsed preferences, or DEFAULT_PREFERENCES if the
 * row has no preferences set OR the column hasn't been migrated yet.
 */
export async function getAdminPreferences(
  adminUserId: string,
): Promise<AdminPreferences> {
  try {
    const result = await adminDrizzle.execute<{ preferences: unknown }>(sql`
      SELECT preferences FROM admin_users
      WHERE id = ${adminUserId}::uuid LIMIT 1
    `);
    return parsePreferences(result.rows[0]?.preferences);
  } catch (err) {
    if (isMissingColumnError(err)) return { ...DEFAULT_PREFERENCES };
    throw err;
  }
}

/**
 * Merge a partial preferences update into the stored blob. Reads the
 * current row first so we never clobber fields the caller didn't
 * explicitly override. Throws a clear error when the column is missing
 * so callers can surface a "run the migration" toast.
 */
export async function setAdminPreferences(
  adminUserId: string,
  partial: Partial<AdminPreferences>,
): Promise<void> {
  // Validate each field before writing so a bad value can't corrupt the
  // blob. Unknown theme/dateFormat values are rejected; unknown timezones
  // are rejected against the runtime's Intl tz database.
  if (partial.theme !== undefined && !THEME_VALUES.includes(partial.theme)) {
    throw new Error("Invalid theme value");
  }
  if (partial.dateFormat !== undefined) {
    if (!DATE_FORMAT_VALUES.includes(partial.dateFormat)) {
      throw new Error("Invalid date format");
    }
  }
  if (partial.timezone !== undefined && partial.timezone !== null) {
    if (!isValidTimezone(partial.timezone)) {
      throw new Error("Unknown timezone");
    }
  }

  // Re-read current prefs so partial updates compose correctly. Using
  // JSONB patching (`jsonb_set`) would avoid the round-trip but adds raw
  // SQL complexity for a feature called once per preference tweak.
  let current: AdminPreferences;
  try {
    current = await getAdminPreferences(adminUserId);
  } catch (err) {
    if (isMissingColumnError(err)) {
      throw new Error(
        "Preferences column is not enabled yet — apply the required admin SQL migration.",
      );
    }
    throw err;
  }

  const merged: AdminPreferences = {
    ...current,
    ...partial,
  };

  try {
    await adminDrizzle.execute(sql`
      UPDATE admin_users
      SET preferences = ${JSON.stringify(merged)}::jsonb,
          updated_at = NOW()
      WHERE id = ${adminUserId}::uuid
    `);
  } catch (err) {
    if (isMissingColumnError(err)) {
      throw new Error(
        "Preferences column is not enabled yet — apply the required admin SQL migration.",
      );
    }
    throw err;
  }
}
