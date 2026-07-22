/**
 * Scope registry for the `/api/v1/*` machine-to-machine surface.
 *
 * Deliberately NOT "server-only": the admin key-management UI imports the
 * catalogue to render the scope picker, and a value import from a
 * server-only module would drag `server-only` into the client bundle.
 * Nothing secret lives here — these are just identifiers + labels.
 *
 * RULES
 *  - Every endpoint declares the scopes it requires; auth denies by default.
 *  - Scopes are additive and least-privilege: grant the narrowest set.
 *  - `read` scopes may ONLY touch the prod game DB read-only. `write` scopes
 *    may ONLY write the ADMIN DB. Nothing in this surface may ever write the
 *    prod game DB — see `withApiKey` for the enforcement note.
 *  - Never rename a scope in place (it silently widens/breaks live keys);
 *    add a new one and revoke the old keys.
 */

export const API_SCOPES = {
  "discord:read": {
    label: "Check Discord links",
    description:
      "Check whether a Discord user ID is linked to a Packy account. Returns only a boolean — no profile data.",
    access: "prod-read",
  },
  "discord:rewards:read": {
    label: "Read claimable rewards",
    description:
      "List what a Discord-linked player can currently claim (names + amounts). Separate from discord:read so reward data can be granted independently.",
    access: "prod-read",
  },
  "users:read": {
    label: "Read users",
    description: "Read user profiles, balances and stats (prod DB, read-only).",
    access: "prod-read",
  },
  "stats:read": {
    label: "Read platform stats",
    description: "Read aggregate platform/dashboard figures (prod DB, read-only).",
    access: "prod-read",
  },
  "notes:write": {
    label: "Write admin records",
    description: "Create records in the admin database (admin DB, write).",
    access: "admin-write",
  },
} as const satisfies Record<
  string,
  { label: string; description: string; access: "prod-read" | "admin-write" }
>;

export type ApiScope = keyof typeof API_SCOPES;

export const ALL_API_SCOPES = Object.keys(API_SCOPES) as ApiScope[];

export function isApiScope(value: string): value is ApiScope {
  return Object.prototype.hasOwnProperty.call(API_SCOPES, value);
}

/** Narrow an untrusted string[] (DB column) to known scopes, dropping stale ones. */
export function toApiScopes(values: readonly string[]): ApiScope[] {
  return values.filter(isApiScope);
}
