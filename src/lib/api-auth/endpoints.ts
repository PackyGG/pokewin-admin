import { API_SCOPES, type ApiScope } from "./scopes";

/**
 * Catalogue of every endpoint on the `/api/v1/*` surface, rendered on
 * /system/api-keys so an operator (or whoever is wiring the Discord bot) can
 * see what exists and which scope unlocks it.
 *
 * Deliberately NOT "server-only" — the admin page renders this client-side.
 * Nothing secret lives here; it is documentation.
 *
 * KEEP IN SYNC: when you add a route under `src/app/api/v1/`, add its entry
 * here with the SAME scopes you passed to `withApiKey`. This list is the
 * human-facing contract; `withApiKey` is the enforcement.
 */

export type ApiEndpointMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type ApiEndpoint = {
  method: ApiEndpointMethod;
  /** Path as called, including the /api/v1 prefix. */
  path: string;
  summary: string;
  /** Scopes required. Empty = any valid, non-revoked key. */
  scopes: readonly ApiScope[];
};

export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    method: "GET",
    path: "/api/v1/whoami",
    summary:
      "Credential self-check — returns the calling key's name and scopes. Useful as a bot smoke test.",
    scopes: [],
  },
];

/** What a given endpoint touches, derived from its scopes (for the UI badge). */
export function endpointAccess(
  endpoint: ApiEndpoint,
): "prod-read" | "admin-write" | "none" {
  if (endpoint.scopes.length === 0) return "none";
  return endpoint.scopes.some((s) => API_SCOPES[s].access === "admin-write")
    ? "admin-write"
    : "prod-read";
}
