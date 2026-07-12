import "server-only";

import { backendApi, BackendApiError } from "@/lib/backend-api";

/**
 * Notify the game backend to invalidate its cached country-restriction data
 * in Redis. This is a DIFFERENT cache than `site_config` — country
 * restrictions have their own dedicated backend endpoint and Redis cache,
 * invalidated wholesale (no per-country-code targeting). See
 * `refreshSiteConfig()` in `src/lib/refresh-site-config.ts` for the
 * site_config sibling; do not conflate the two.
 *
 * Routes through the central backendApi client so env-specific URL+key
 * (BACKEND_API_URL_PROD/_DEV + BACKEND_ADMIN_KEY_PROD/_DEV), Cloudflare
 * Access service tokens, and the `x-bypass-secret` header are all picked
 * up automatically. Failures are logged but not thrown — the underlying
 * DB write has already succeeded by the time this is called, and forcing
 * the admin action to roll back on a transient backend hiccup would be
 * worse than letting the cache expire naturally.
 */
export async function invalidateCountryRestrictionsCache(): Promise<void> {
  try {
    await backendApi.post("/admin/invalidate-country-restrictions-cache");
    console.log("[invalidateCountryRestrictionsCache] backend ok");
  } catch (e) {
    if (e instanceof BackendApiError) {
      console.error(
        `[invalidateCountryRestrictionsCache] backend error status=${e.status} code=${e.code ?? "none"} payload=${JSON.stringify(e.payload)}`,
      );
      return;
    }
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[invalidateCountryRestrictionsCache] failed: ${message}`, e);
  }
}
