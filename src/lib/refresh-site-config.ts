/**
 * Notify the game backend to reload its cached site_config.
 *
 * The backend (BACKEND_API_URL) caches site_config in-process for
 * performance. After any admin write to the site_config table we POST
 * /admin/refresh_site_config so the new values take effect without
 * waiting for the cache to expire.
 *
 * Uses BACKEND_API_URL + BACKEND_API_KEY env vars, and optionally
 * BACKEND_BYPASS_SECRET if that header is expected. Failures are
 * logged but not thrown — the underlying DB write has already
 * succeeded by the time this is called, and forcing the admin action
 * to roll back on a transient backend hiccup would be worse than
 * letting the cache expire naturally.
 */
export async function refreshSiteConfig(): Promise<void> {
  const headers: Record<string, string> = {
    "x-api-key": process.env.BACKEND_API_KEY!,
  };
  if (process.env.BACKEND_BYPASS_SECRET) {
    headers["x-bypass-secret"] = process.env.BACKEND_BYPASS_SECRET;
  }

  try {
    const res = await fetch(
      `${process.env.BACKEND_API_URL}/admin/refresh_site_config`,
      { method: "POST", headers },
    );
    if (!res.ok) {
      console.error(
        "[refreshSiteConfig]",
        res.status,
        await res.text().catch(() => ""),
      );
    }
  } catch (e) {
    console.error("[refreshSiteConfig] Failed:", e);
  }
}
