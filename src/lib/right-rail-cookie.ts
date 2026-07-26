// ---------------------------------------------------------------------------
// Right-rail cookie constants + codec — importable from BOTH client and server.
// ---------------------------------------------------------------------------
//
// Mirrors the `TZ_COOKIE` / `DB_ENV_COOKIE` precedent (see
// `src/lib/timezone/cookie.ts` + `src/lib/db-env.ts`): a tiny, dependency-free
// module holding the cookie name + write options + a pure codec so the client
// provider (which writes it via `document.cookie`) and the server reader (in
// the layout) agree on a single name and wire format.
//
// This file is pure constants + pure functions — NO React, NO next/headers,
// NO window — so it is safe to import from any runtime (RSC, client component,
// route handler, middleware).
//
// ─── Why a cookie ──────────────────────────────────────────────────────────
// Creator Hub's docked Alerts panel persists its open/collapsed state in
// localStorage. localStorage is client-only, so the
// SERVER render + first client render can't know the admin's saved layout —
// they fall back to a default, then a post-mount effect snaps to the stored
// state. That snap is the visible "rail flashes open then closed on reload"
// jank. Writing the same choice to a cookie the Server Component layout can
// read lets SSR and the first client paint use the admin's ACTUAL layout, so
// there is no post-mount correction. Identical mechanism to the `admin_tz`
// cookie that removed the timezone hydration flash.
// ---------------------------------------------------------------------------

export const RAIL_KEYS = ["alerts"] as const;
export type RailKey = (typeof RAIL_KEYS)[number];

/**
 * Cookie holding the right-rail open state. Written client-side whenever the
 * admin toggles a dock (see right-rail-context.tsx) and read server-side in
 * the admin layout so the FIRST server render of the next request already
 * knows whether the dock is open — eliminating the open/close flash a pure
 * post-mount localStorage read causes.
 *
 * Wire format: `"alerts"` when open or an empty string when closed.
 */
export const RAIL_COOKIE = "admin_rail";

/** One year, in seconds — the cookie Max-Age (matches the tz cookie). */
export const RAIL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function isRailKey(value: string): value is RailKey {
  return (RAIL_KEYS as readonly string[]).includes(value);
}

/**
 * Serialize an insertion-ordered list of open keys to the cookie value.
 * Filters to known keys and de-dupes so a caller can pass the raw openOrder.
 */
export function serializeRailOpenOrder(openOrder: readonly string[]): string {
  const seen = new Set<RailKey>();
  const out: RailKey[] = [];
  for (const k of openOrder) {
    if (isRailKey(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out.join(",");
}

/**
 * Parse a `RAIL_COOKIE` value back into an insertion-ordered list of open
 * keys. Unknown / duplicate entries are dropped so a corrupted cookie can
 * never crash the rail. Returns `null` when the value is absent so callers
 * can distinguish "no cookie yet" (use the default layout) from "explicitly
 * nothing open" (empty string → `[]`).
 */
export function parseRailOpenOrder(raw: string | null | undefined): RailKey[] | null {
  if (raw == null) return null;
  const seen = new Set<RailKey>();
  const out: RailKey[] = [];
  for (const part of raw.split(",")) {
    const k = part.trim();
    if (isRailKey(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * The `document.cookie` write string for a given open-order. Centralised here
 * so the client writer can't drift from the name/attributes the server reader
 * expects. `SameSite=Lax` + `Path=/` matches the db-env / tz cookies' scope
 * (admin-wide, first-party). No `Secure` flag so it still works on
 * `http://localhost` during dev; production is HTTPS-only at the edge.
 */
export function railCookieWriteString(openOrder: readonly string[]): string {
  const value = serializeRailOpenOrder(openOrder);
  return `${RAIL_COOKIE}=${value}; Max-Age=${RAIL_COOKIE_MAX_AGE}; SameSite=Lax; Path=/`;
}
