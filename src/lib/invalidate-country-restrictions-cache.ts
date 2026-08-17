import "server-only";

import { backendApi, BackendApiError } from "@/lib/backend-api";
import { logError, logInfo } from "@/lib/errors/logger";

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
 *
 * Returns whether the backend bust succeeded, so awaited call sites (the
 * geo-blocking mutations feeding `countryRestrictionsCacheReloaded` into
 * the UI's stale-cache warning toast) can surface a failed bust without
 * this helper ever throwing. Fire-and-forget callers can ignore it.
 */
export async function invalidateCountryRestrictionsCache(): Promise<boolean> {
  try {
    await backendApi.post("/admin/invalidate-country-restrictions-cache");
    logInfo("country-restrictions.invalidate", "backend cache invalidated");
    return true;
  } catch (e) {
    if (e instanceof BackendApiError) {
      logError(
        "country-restrictions.invalidate",
        `backend cache invalidation failed status=${e.status}`,
        e,
      );
      return false;
    }
    logError(
      "country-restrictions.invalidate",
      "backend cache invalidation failed",
      e,
    );
    return false;
  }
}
