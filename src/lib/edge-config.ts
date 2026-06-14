import "server-only";

import { createClient, type EdgeConfigClient } from "@vercel/edge-config";

/**
 * Vercel Edge Config helper — low-latency, read-heavy config + feature flags.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────
 * Edge Config is Vercel's globally-replicated, ultra-low-latency store for
 * values that are READ ON ALMOST EVERY REQUEST but WRITTEN RARELY:
 *   • feature flags / kill-switches
 *   • tunable thresholds + default page sizes
 *   • small allow/deny lists
 *   • environment-level config that shouldn't require a redeploy to change
 *
 * It is NOT a general cache. For values that mutate frequently (per-request
 * memoization of slow / rate-limited upstream work) use the dormant Upstash
 * Redis read-through layer instead — see `src/lib/cache/redis.ts`
 * (`cacheGetOrSet`). Edge Config writes go through the Vercel dashboard / API
 * and propagate globally; it is the wrong tool for hot, churny data.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * GRACEFUL-DEGRADE CONTRACT (the whole point of this module)
 * ─────────────────────────────────────────────────────────────────────────
 * This helper MUST never throw and MUST never change behavior when Edge
 * Config is absent or misbehaving:
 *   • No `EDGE_CONFIG` env (local dev, or store not yet connected)
 *     → the client is never constructed; every read returns the caller's
 *       supplied `fallback`. Behavior is EXACTLY as if this layer didn't
 *       exist — callers must pass the current hard-coded value as `fallback`.
 *   • ANY SDK error (network, auth, parse, missing key) on a read
 *     → swallowed; the `fallback` is returned. A read failure can NEVER
 *       bubble to a caller and can NEVER alter the result.
 *
 * Because of that contract this module never throws at import time and never
 * throws from any exported function. No secrets are logged.
 */

// Lazily-resolved singleton. `undefined` = not yet resolved; `null` = resolved
// to "no client" (env absent / construction failed) and cached so we don't
// re-check the env on every call.
let resolvedClient: EdgeConfigClient | null | undefined;

/**
 * Lazy singleton accessor. Reads `process.env.EDGE_CONFIG` (the connection
 * string the Vercel Edge Config integration injects) on first call:
 *   • present → construct and cache an `EdgeConfigClient`.
 *   • absent  → cache `null` (dormant) so callers degrade to their fallback.
 *
 * Never throws at module load and never throws here — a malformed connection
 * string that makes the constructor throw is treated as "no client" (dormant).
 */
function getEdgeConfigClient(): EdgeConfigClient | null {
  if (resolvedClient !== undefined) return resolvedClient;

  const connectionString = process.env.EDGE_CONFIG?.trim();
  if (!connectionString) {
    resolvedClient = null;
    return resolvedClient;
  }

  try {
    resolvedClient = createClient(connectionString);
  } catch {
    // A bad connection string must not break callers — stay dormant.
    resolvedClient = null;
  }
  return resolvedClient;
}

/** True only when a usable Edge Config client is configured. */
export function isEdgeConfigEnabled(): boolean {
  return getEdgeConfigClient() !== null;
}

/**
 * Read a single Edge Config value by `key`, typed as `T`.
 *
 * GRACEFUL DEGRADE (hard guarantees):
 *   • No client (dormant)        → returns `fallback`, no network I/O.
 *   • SDK read throws            → swallowed; returns `fallback`.
 *   • Key missing (undefined)    → returns `fallback`.
 *
 * Always pass the current hard-coded value as `fallback` so behavior is
 * unchanged when Edge Config is unset. The cast to `T` trusts the store's
 * shape for `key`; validate at the call site if the value is untrusted.
 */
export async function getCachedConfig<T>(
  key: string,
  fallback?: T,
): Promise<T | undefined> {
  const client = getEdgeConfigClient();
  if (!client) return fallback;

  try {
    const value = await client.get<T>(key);
    return value === undefined ? fallback : value;
  } catch {
    // Any read failure degrades to the fallback — never surface to the caller.
    return fallback;
  }
}

/**
 * Read a boolean feature flag by `key`. Returns `fallback` (default `false`)
 * when Edge Config is dormant, the key is missing, the read throws, or the
 * stored value is not a boolean. Fail-safe by default: an absent flag stays
 * off unless the caller opts into a different default.
 */
export async function getFeatureFlag(
  key: string,
  fallback = false,
): Promise<boolean> {
  const value = await getCachedConfig<unknown>(key, fallback);
  return typeof value === "boolean" ? value : fallback;
}
