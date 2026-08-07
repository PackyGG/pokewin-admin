/**
 * Browser persistence is optional UI state. Browsers can deny access to it
 * (private/locked-down contexts), and users can carry malformed values across
 * deployments. Neither case may be allowed to crash the application shell.
 */
export type BrowserStorageKind = "local" | "session";

export function toValidIso(
  value: string | number | Date | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

function getStorage(kind: BrowserStorageKind): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readBrowserStorage(
  key: string,
  kind: BrowserStorageKind = "local",
): string | null {
  try {
    return getStorage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeBrowserStorage(
  key: string,
  value: string,
  kind: BrowserStorageKind = "local",
): boolean {
  try {
    const storage = getStorage(kind);
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeBrowserStorage(
  key: string,
  kind: BrowserStorageKind = "local",
): boolean {
  try {
    const storage = getStorage(kind);
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Accept only a plain boolean map. This prevents arrays, null, primitives,
 * prototype keys, and stale non-boolean values from reaching render logic.
 */
export function parseBooleanRecord(
  raw: string | null,
  allowedKeys?: ReadonlySet<string>,
): Record<string, boolean> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        continue;
      }
      if (value !== true && value !== false) continue;
      if (allowedKeys && !allowedKeys.has(key)) continue;
      result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
}
