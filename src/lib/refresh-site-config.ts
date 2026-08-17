import "server-only";

import { backendApi, BackendApiError } from "@/lib/backend-api";
import { logError, logInfo } from "@/lib/errors/logger";

/**
 * Notify the game backend to reload its cached site_config.
 *
 * Routes through the central backendApi client so env-specific URL+key
 * (BACKEND_API_URL_PROD/_DEV + BACKEND_ADMIN_KEY_PROD/_DEV), Cloudflare
 * Access service tokens, and the `x-bypass-secret` header are all picked
 * up automatically. Failures are logged but not thrown — the underlying
 * DB write has already succeeded by the time this is called, and forcing
 * the admin action to roll back on a transient backend hiccup would be
 * worse than letting the cache expire naturally.
 */
export async function refreshSiteConfig(): Promise<void> {
  try {
    await backendApi.post("/admin/refresh-site-config");
    logInfo("site-config.refresh", "backend cache refreshed");
  } catch (e) {
    if (e instanceof BackendApiError) {
      logError(
        "site-config.refresh",
        `backend cache refresh failed status=${e.status}`,
        e,
      );
      return;
    }
    logError("site-config.refresh", "backend cache refresh failed", e);
  }
}
