import "server-only";

import { backendApi, BackendApiError } from "@/lib/backend-api";

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
    console.log("[refreshSiteConfig] backend ok");
  } catch (e) {
    if (e instanceof BackendApiError) {
      console.error(
        `[refreshSiteConfig] backend error status=${e.status} code=${e.code ?? "none"} payload=${JSON.stringify(e.payload)}`,
      );
      return;
    }
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[refreshSiteConfig] failed: ${message}`, e);
  }
}
