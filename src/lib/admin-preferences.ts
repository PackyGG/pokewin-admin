import { adminDb } from "@/lib/admin-db";

/**
 * Per-admin preferences blob stored in `admin_users.preferences` (JSONB).
 *
 * Adding a new preference field is additive — existing rows keep working
 * because the parser below drops unknown fields and substitutes defaults
 * for missing ones. Never rename fields in place without a data migration.
 */
export type AdminPreferences = {
  /** UI theme. Falls back to "system" when the column is unset. */
  theme: "light" | "dark" | "system";
  /**
   * IANA timezone identifier (e.g. "Europe/Berlin"). `null` means
   * "use the browser's detected timezone" — the client provider falls
   * back to Intl.DateTimeFormat().resolvedOptions().timeZone.
   */
  timezone: string | null;
  /** Preferred date format preset. Rendered via date-fns `format`. */
  dateFormat?: "MMM d, yyyy" | "dd/MM/yyyy" | "yyyy-MM-dd";
  // Reserved for future slots:
  //   compactTables?: boolean;
  //   defaultDashboardPeriod?: "24h" | "7d" | "30d";
};

export const DEFAULT_PREFERENCES: AdminPreferences = {
  theme: "system",
  timezone: null,
};

/**
 * Known values for `theme` and `dateFormat`. Kept here so the profile UI
 * can render radio groups without duplicating string literals.
 */
export const THEME_VALUES: ReadonlyArray<AdminPreferences["theme"]> = [
  "light",
  "dark",
  "system",
];

export const DATE_FORMAT_VALUES: ReadonlyArray<NonNullable<AdminPreferences["dateFormat"]>> = [
  "MMM d, yyyy",
  "dd/MM/yyyy",
  "yyyy-MM-dd",
];

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

  const theme: AdminPreferences["theme"] =
    obj.theme === "light" || obj.theme === "dark" || obj.theme === "system"
      ? obj.theme
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

/**
 * Server-safe IANA timezone check — uses Intl.DateTimeFormat which is
 * available in both Node and the browser. Returns true if the zone is
 * accepted by the runtime, false otherwise (incl. malformed strings).
 */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// ---- Graceful pre-migration handling ------------------------------------

// Mirrors the admin-settings.ts pattern. If the `preferences` column
// hasn't been migrated yet we want to return DEFAULT_PREFERENCES instead
// of blowing up the layout — callers can render a pre-migration banner
// if needed, and the rest of the UI falls back to browser-detected zone.
function isMissingColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "P2022") return true;
  return /column .* does not exist/i.test(err.message);
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
    const row = await adminDb.admin_users.findUnique({
      where: { id: adminUserId },
      select: { preferences: true },
    });
    return parsePreferences(row?.preferences);
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
        "Preferences column is not enabled yet — run the database migration (npm run admin:migrate).",
      );
    }
    throw err;
  }

  const merged: AdminPreferences = {
    ...current,
    ...partial,
  };

  try {
    await adminDb.admin_users.update({
      where: { id: adminUserId },
      // JSONB-typed column: Prisma accepts a plain object which it
      // serializes via its input JSON encoder.
      data: { preferences: merged },
    });
  } catch (err) {
    if (isMissingColumnError(err)) {
      throw new Error(
        "Preferences column is not enabled yet — run the database migration (npm run admin:migrate).",
      );
    }
    throw err;
  }
}
