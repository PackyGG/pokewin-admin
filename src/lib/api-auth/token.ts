import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API token format, generation and comparison primitives.
 *
 * TOKEN SHAPE:  `pwa_<prefix>.<secret>`
 *   - `pwa_<prefix>`  PUBLIC identifier. Stored in `api_keys.prefix` (unique,
 *                     indexed) so auth can find the row with ONE lookup
 *                     instead of scanning + hashing every key.
 *   - `<secret>`      256 bits of CSPRNG entropy, base64url. Never stored.
 *
 * AT REST we keep only SHA-256(full token). SHA-256 (not bcrypt/argon2) is the
 * correct choice here precisely BECAUSE the secret is 256-bit random: there is
 * no dictionary to attack, so a slow KDF buys nothing and would add latency to
 * every request. The threat bcrypt defends against (low-entropy human
 * passwords) does not exist for these tokens.
 *
 * Comparison is ALWAYS constant-time (`timingSafeEqual`) so response timing
 * can't be used to recover a hash byte-by-byte.
 */

/** Brand marker so a stray secret is greppable/identifiable in logs + leaks. */
const TOKEN_BRAND = "pwa";
/** Bytes of public prefix entropy (collision-safe well beyond key volume). */
const PREFIX_BYTES = 9;
/** Bytes of secret entropy. 32 = 256 bits. */
const SECRET_BYTES = 32;
/** Separator between the public prefix and the secret. */
const SEPARATOR = ".";

export type GeneratedApiKey = {
  /** FULL token — return to the operator ONCE, never persist. */
  token: string;
  /** Public identifier to store + display. */
  prefix: string;
  /** SHA-256 hex of `token` — the only credential material we persist. */
  keyHash: string;
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Mint a new key. The caller stores `prefix` + `keyHash` and shows `token` once. */
export function generateApiKey(): GeneratedApiKey {
  const prefix = `${TOKEN_BRAND}_${randomBytes(PREFIX_BYTES).toString("base64url")}`;
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const token = `${prefix}${SEPARATOR}${secret}`;
  return { token, prefix, keyHash: sha256Hex(token) };
}

/**
 * Extract the public prefix from a presented token WITHOUT trusting it.
 * Returns null on any shape violation so callers reject before touching the DB.
 */
export function parseTokenPrefix(token: string): string | null {
  // Bound the input so a megabyte "token" can't cost us a hash or a query.
  if (token.length < 16 || token.length > 512) return null;
  const idx = token.indexOf(SEPARATOR);
  if (idx <= 0 || idx === token.length - 1) return null;
  const prefix = token.slice(0, idx);
  if (!prefix.startsWith(`${TOKEN_BRAND}_`)) return null;
  // Prefix must be plain base64url after the brand — keeps the DB lookup
  // parameter to a known-safe alphabet.
  if (!/^[A-Za-z0-9_-]+$/.test(prefix.slice(TOKEN_BRAND.length + 1))) return null;
  return prefix;
}

/** Constant-time compare of two hex digests. False on any length mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Display form for the admin UI — never reveals secret material (the secret
 * isn't recoverable anyway; this just keeps the table tidy).
 */
export function maskedKeyDisplay(prefix: string): string {
  return `${prefix}${SEPARATOR}${"•".repeat(12)}`;
}
