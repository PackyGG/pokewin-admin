import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { getSession } from "@/lib/session";
import { TZ_COOKIE } from "./cookie";
import { getEffectiveTimeZone, isValidTimeZone } from "./core";

// ---------------------------------------------------------------------------
// Server-side timezone resolution.
// ---------------------------------------------------------------------------
//
// Mirrors `src/lib/db-env.ts` precisely (the project's established cookie-
// for-per-request-personalization precedent):
//   • `cache()`-wrapped so one cookie read serves every query in a render.
//   • `try/catch` around `cookies()` so non-request contexts (cron,
//     `unstable_cache`, top-level module code) degrade gracefully instead
//     of throwing.
//   • NEVER references `window` — the browser-zone detection lives in
//     core.ts (`getBrowserTimeZone`) guarded by `typeof window` and is only
//     ever invoked inside the CLIENT provider's effect. Server code reads
//     the cookie that effect wrote.
//
// Resolution precedence (identical to the client provider, so SSR and the
// first client paint agree → no hydration flash):
//
//   explicit DB preference  →  admin_tz cookie  →  "UTC"
// ---------------------------------------------------------------------------

/**
 * The browser-detected zone from the `admin_tz` cookie, or `null` if the
 * cookie is absent / invalid / unreadable (non-request context). This is
 * the FALLBACK candidate — an explicit profile preference always wins.
 *
 * Not memoized (the layout shell calls it once per render alongside the
 * db-env read); use `getServerTimeZone` for the resolved value at query
 * sites so the cookie read is cached across the render.
 */
export async function readTzCookie(): Promise<string | null> {
  try {
    const jar = await cookies();
    const raw = jar.get(TZ_COOKIE)?.value;
    if (raw) {
      const decoded = decodeURIComponent(raw);
      if (isValidTimeZone(decoded)) return decoded;
    }
  } catch {
    // cookies() only works inside a request scope — background contexts
    // fall through to null (caller resolves to UTC).
  }
  return null;
}

/**
 * Resolve the effective IANA zone for the current request.
 *
 * @param explicitPref the admin's stored `preferences.timezone` (null when
 *   they haven't picked one). Pass it in — server.ts does not read the DB.
 *
 * Memoized per render via `cache()` so multiple query helpers in one page
 * pay the cookie read once (same shape as `readDbEnv`).
 */
export const getServerTimeZone = cache(
  async (explicitPref: string | null): Promise<string> => {
    // Fast path: a valid explicit preference needs no cookie read.
    if (explicitPref && isValidTimeZone(explicitPref)) return explicitPref;
    const cookieTz = await readTzCookie();
    return getEffectiveTimeZone(explicitPref, cookieTz);
  },
);

/**
 * Resolved IANA zone for the signed-in admin's current request — profile
 * preference → `admin_tz` cookie → UTC. Use at server render sites that
 * call `formatDateTime(d, tz)` so SSR matches the TimezoneProvider.
 */
export const getAdminDisplayTimeZone = cache(async (): Promise<string> => {
  try {
    const session = await getSession();
    const explicitPref = session
      ? (await getAdminPreferences(session.userId)).timezone
      : null;
    return getServerTimeZone(explicitPref);
  } catch {
    return "UTC";
  }
});
