import "server-only";

/**
 * Client-IP resolution + allowlist matching for the `/api/v1` surface.
 *
 * ── HOW MUCH TO TRUST THE IP ──────────────────────────────────────────────
 * Every one of these values arrives as an HTTP header, so the guarantee is
 * only as strong as the proxy in front of us OVERWRITING what a client sends.
 * The order below is deliberate, most-trustworthy first:
 *
 *   1. `x-vercel-forwarded-for` — set by Vercel's edge and NOT forwardable by
 *      a caller, so it can't be spoofed from outside.
 *   2. `x-real-ip` — also platform-set on Vercel.
 *   3. `x-forwarded-for` (first hop) — the standard header, but a client can
 *      send its own; we only reach it if neither of the above is present.
 *
 * Treat the allowlist as DEFENCE IN DEPTH layered on the bearer token, never
 * as a replacement for it: behind a misconfigured proxy that passes client
 * headers through, an attacker holding a stolen token could forge the header.
 * The token is the primary control; this shrinks the blast radius if it leaks.
 */

/** Ordered by how hard the header is to forge. */
const IP_HEADERS = [
  "x-vercel-forwarded-for",
  "x-real-ip",
  "x-forwarded-for",
] as const;

/**
 * Normalise an address so textual variants of the SAME host compare equal:
 * lowercase, surrounding brackets removed, IPv4-mapped IPv6 (`::ffff:1.2.3.4`)
 * reduced to its IPv4 form, and any `:port` suffix stripped from IPv4.
 */
export function normalizeIp(value: string): string {
  let ip = value.trim().toLowerCase();
  if (!ip) return "";

  // [2001:db8::1]:443 → 2001:db8::1
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed?.[1]) ip = bracketed[1];

  // IPv4-mapped IPv6 → plain IPv4 so ::ffff:1.2.3.4 matches 1.2.3.4
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped?.[1]) ip = mapped[1];

  // Strip a port from IPv4 only — a bare IPv6 is full of colons.
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (withPort?.[1]) ip = withPort[1];

  return ip;
}

/**
 * Resolve the caller's IP, or `null` when no proxy header is present (e.g. a
 * direct local request). Callers MUST treat `null` as "unknown" and fail
 * closed when an allowlist is configured.
 */
export function resolveClientIp(request: Request): string | null {
  for (const header of IP_HEADERS) {
    const raw = request.headers.get(header);
    if (!raw) continue;
    // These headers may carry a chain: "client, proxy1, proxy2". The first
    // entry is the originating client.
    const first = raw.split(",")[0];
    const normalized = normalizeIp(first ?? "");
    if (normalized) return normalized.slice(0, 100);
  }
  return null;
}

/**
 * Is `ip` permitted by `allowlist`?
 *
 *  - EMPTY allowlist → always true (feature off for that key).
 *  - Non-empty + unknown IP (`null`) → FALSE. Failing open here would let
 *    anyone who can suppress the proxy headers bypass the restriction, which
 *    would make the whole control worthless.
 *
 * Matching is exact (after normalisation). CIDR ranges are intentionally NOT
 * supported yet — a subtly wrong range matcher in a security control is worse
 * than no ranges. List each egress address explicitly.
 */
export function isIpAllowed(
  ip: string | null,
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;
  const candidate = normalizeIp(ip);
  if (!candidate) return false;
  return allowlist.some((entry) => normalizeIp(entry) === candidate);
}

/** Loose shape check for operator input — rejects obvious typos, not a parser. */
export function looksLikeIp(value: string): boolean {
  const ip = normalizeIp(value);
  if (!ip) return false;
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
  if (ipv4.test(ip)) {
    return ip.split(".").every((part) => Number(part) <= 255);
  }
  // Permissive IPv6: hex groups and colons, optionally with a trailing IPv4.
  return /^[0-9a-f:]+(?:\.\d{1,3}){0,3}$/.test(ip) && ip.includes(":");
}
