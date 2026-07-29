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

/**
 * Wildcard scope. A key holding it satisfies EVERY scope check, including
 * scopes that don't exist yet — so an endpoint added next month is
 * immediately callable without re-issuing the key.
 *
 * That convenience is exactly the risk: it is a standing grant to the whole
 * surface. Prefer granular scopes for anything third-party (the Discord bot
 * gets `discord:*`, not this). Reach for it for a trusted first-party
 * consumer, or while prototyping.
 */
export const FULL_ACCESS_SCOPE = "*";

export const API_SCOPES = {
  "*": {
    label: "Full access",
    description:
      "Satisfies every scope check, including endpoints added later. Grant only to a trusted first-party consumer — prefer the granular scopes below.",
    access: "full",
  },
  "discord:read": {
    label: "Check Discord links",
    description:
      "Check whether a Discord user ID is linked to a Packy account. Returns only a boolean — no profile data.",
    access: "prod-read",
  },
  "discord:rewards:read": {
    label: "Read claimable rewards",
    description:
      "List what a Discord-linked player can currently claim (names + amounts). Tracks creator-reward offer windows in the admin DB so expiry is enforced consistently.",
    access: "admin-write",
  },
  "discord:info:read": {
    label: "Read a player's reward summary",
    description:
      "Username, user id, current code + time left on it, and rewards open / pending / claimed. UNLIKE the other Discord scopes this returns PROFILE DATA — grant it only to a bot that renders a player-facing card.",
    access: "admin-write",
  },
  "discord:creator:read": {
    label: "Read creator performance",
    description:
      "Read the linked creator's own code, configured reward legs, player counts, wager volume, and reward payouts. The caller cannot choose a code.",
    access: "prod-read",
  },
  "discord:antifraud": {
    label: "Deliver Antifraud notifications",
    description:
      "Synchronize Discord channels and claim, acknowledge, or enqueue durable Antifraud notification jobs. Writes only the admin database.",
    access: "admin-write",
  },
  "discord:verify": {
    label: "Run Discord verification",
    description:
      "Confirm a Discord account is linked AND record that the player has verified (first/last time, count). Writes only that record in the admin DB — no profile data is returned.",
    access: "admin-write",
  },
  "discord:rewards:claim": {
    label: "File reward claims",
    description:
      "Let a Discord-linked player file a claim request for a creator VIP wager reward. Writes ONLY a pending row in the admin DB — it never moves balance; a human still has to approve it.",
    access: "admin-write",
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
  {
    label: string;
    description: string;
    access: "prod-read" | "admin-write" | "full";
  }
>;

export type ApiScope = keyof typeof API_SCOPES;

export const ALL_API_SCOPES = Object.keys(API_SCOPES) as ApiScope[];

/** Granular scopes only — the wildcard is presented separately in the UI. */
export const GRANULAR_API_SCOPES = ALL_API_SCOPES.filter(
  (scope) => scope !== FULL_ACCESS_SCOPE,
);

export function isApiScope(value: string): value is ApiScope {
  return Object.prototype.hasOwnProperty.call(API_SCOPES, value);
}

/** Narrow an untrusted string[] (DB column) to known scopes, dropping stale ones. */
export function toApiScopes(values: readonly string[]): ApiScope[] {
  return values.filter(isApiScope);
}

/** True when the key holds the wildcard grant. */
export function hasFullAccess(granted: readonly string[]): boolean {
  return granted.includes(FULL_ACCESS_SCOPE);
}

/**
 * Which of `required` the key does NOT hold. Empty = authorized.
 *
 * The wildcard short-circuits: a `*` key is missing nothing, which is what
 * makes future endpoints work without re-issuing it.
 */
export function missingScopes(
  granted: readonly string[],
  required: readonly ApiScope[],
): ApiScope[] {
  if (hasFullAccess(granted)) return [];
  return required.filter((scope) => !granted.includes(scope));
}
