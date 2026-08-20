import type { AdminPreferences } from "@/lib/admin-preferences-types";

type FetchThemePreference = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Persist a theme through a stable HTTP endpoint. Unlike a Next Server Action
 * identifier, this URL remains valid when a long-open dashboard tab spans a
 * production deployment.
 */
export async function saveThemePreference(
  theme: AdminPreferences["theme"],
  fetchThemePreference: FetchThemePreference = fetch,
): Promise<void> {
  const response = await fetchThemePreference("/api/profile/preferences/theme", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme }),
  });

  if (!response.ok) {
    throw new Error("Could not sync theme preference");
  }
}
