import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string compare for SECRETS (cron bearer tokens, shared
 * keys, HMAC digests).
 *
 * `a !== b` short-circuits at the first differing byte, so the response
 * time leaks how much of a guessed secret is correct — enough to recover
 * it byte by byte from a remote endpoint. `timingSafeEqual` compares the
 * whole buffer regardless.
 *
 * Length is checked first because `timingSafeEqual` THROWS on unequal
 * buffer lengths. That check is itself a (tiny) leak of the secret's
 * length, which is the standard, accepted trade — the same shape
 * `api-auth/token.ts` and the antifraud ingest route already use.
 *
 * Node-runtime only (`node:crypto`); do not import from an Edge route.
 */
export function constantTimeEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
