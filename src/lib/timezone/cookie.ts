// ---------------------------------------------------------------------------
// Timezone cookie constants — importable from BOTH client and server.
// ---------------------------------------------------------------------------
//
// Mirrors the `DB_ENV_COOKIE` precedent in `src/lib/db-env.ts`: a tiny,
// dependency-free module holding the cookie name + write options so the
// client provider (which writes it via `document.cookie`) and the server
// reader (`getServerTimeZone` in ./server.ts) agree on a single name.
//
// This file is pure constants — NO React, NO next/headers, NO window — so
// it is safe to import from any runtime (RSC, client component, route
// handler, middleware).
// ---------------------------------------------------------------------------

/**
 * Cookie holding the browser-detected IANA zone. Written client-side on
 * mount (see timezone-provider.tsx) and read server-side so the FIRST
 * server render of the next request already knows the viewer's zone —
 * eliminating the hydration flash that a pure post-mount detect causes.
 *
 * This is the AUTO-DETECTED zone only. An explicit profile preference
 * (the `preferences.timezone` DB column) always wins over it; the cookie
 * is the fallback used when no explicit preference exists.
 */
export const TZ_COOKIE = "admin_tz";

/** One year, in seconds — the cookie Max-Age. */
export const TZ_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The `document.cookie` write string for a detected zone. Centralised here
 * so the client writer can't drift from the name/attributes the server
 * reader expects. `SameSite=Lax` + `Path=/` matches the db-env cookie's
 * scope (admin-wide, first-party). No `Secure` flag is set here so it
 * still works on `http://localhost` during dev; production is HTTPS-only
 * at the platform edge regardless.
 */
export function tzCookieWriteString(tz: string): string {
  return `${TZ_COOKIE}=${encodeURIComponent(tz)}; Max-Age=${TZ_COOKIE_MAX_AGE}; SameSite=Lax; Path=/`;
}
