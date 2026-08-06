import { API_SCOPES, type ApiScope } from "./scopes";

/**
 * Catalogue of every endpoint on the `/api/v1/*` surface, rendered on
 * /system/admin-api so an operator (or whoever is wiring the Discord bot) can
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
    method: "POST",
    path: "/api/v1/discord/linked",
    summary:
      "Body { discordUserId }. Returns { linked: boolean } — whether that Discord account is linked to a Packy account. Boolean only, no profile data.",
    scopes: ["discord:read"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/verify",
    summary:
      "Body { discordUserId }. The bot's /verify command: confirms the link AND records the verification. Returns { linked, alreadyVerified, firstVerifiedAt, verifyCount } so the bot can tell a first-time verify from a repeat. 404 not_linked writes nothing.",
    scopes: ["discord:verify"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/rewards",
    summary:
      "Body { discordUserId }. Returns { claimable: [...] } — unopened one-time rewards plus unclaimed rakeback (summed per cadence). Empty array = nothing to claim; 404 not_linked if the Discord account isn't linked.",
    scopes: ["discord:rewards:read"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/info",
    summary:
      "Body { discordUserId }. The player's summary card: username, user id, current code, seconds left on the code, and rewards open / pending review / claimed. RETURNS PROFILE DATA — separate scope on purpose.",
    scopes: ["discord:info:read"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/prepare",
    summary:
      "Body { guildId, creatorDiscordUserId, createdByDiscordUserId, interactionId }. Validates the linked creator and reserves one setup before Discord channels are created.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/complete",
    summary:
      "Body { reservationId, guildId, creatorDiscordUserId, categoryId, chatChannelId, logsChannelId, categoryName }. Idempotently activates a reserved creator setup.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/repair",
    summary:
      "Body { guildId, creatorDiscordUserId, previousCategoryId, previousChatChannelId, previousLogsChannelId, categoryId, chatChannelId, logsChannelId, categoryName, actorDiscordUserId, interactionId }. Atomically replaces stale Discord channel IDs after the bot confirms they no longer form a valid creator section.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/cancel",
    summary:
      "Body { reservationId }. Idempotently removes only an unfinished creator setup reservation.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/link",
    summary:
      "Body { guildId, categoryId, channelId, creatorUserId, actorDiscordUserId, interactionId }. Staff-only first-time binding links an active creator section to the selected Packy account and grants its missing creator role. This system mapping does not require or change the account's on-site Discord OAuth link. Channel, actor, conflicts, and idempotency are verified server-side.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/stats",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId }. Returns rolling 30-day combined totals and a per-code breakdown for every affiliate code owned by the Packy creator linked to that private Discord section. Deposit volume includes every completed fiat or crypto deposit attributed in the window.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/dashboard-context",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId }. Returns only the linked Packy user ID for an authorized dashboard operator in an active creator section.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/deal",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId }. Returns the current active or scheduled creator-facing deal terms for the Packy creator linked to that private Discord section. Internal IDs, notes, versions, and admin metadata are omitted.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/rewards",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId }. Returns active creator-facing reward-program terms for the Packy creator linked to that private Discord section. Internal IDs, staff data, claim totals, and payout history are omitted.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/vips/link-preview",
    summary:
      "Body { guildId, channelId, memberDiscordUserId, userId, actorDiscordUserId }. VIPs-only read that returns the Packy username and VIP-tag preview before a staff member confirms a channel link.",
    scopes: ["discord:vips:link"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/vips/dashboard-context",
    summary:
      "Body { guildId, channelId, actorDiscordUserId }. Returns only the Packy user ID linked to that VIP channel for an authorized dashboard operator.",
    scopes: ["discord:vips:link"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/vips/link",
    summary:
      "Body { guildId, channelId, memberDiscordUserId, userId, actorDiscordUserId, interactionId }. VIPs-only idempotent write that adds the Admin VIP tag when missing and stores the Packy user, Discord member, and channel mapping.",
    scopes: ["discord:vips:link"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/reminders",
    summary:
      "Body { interactionId, guildId, sourceChannelId, userId }. Idempotently schedules a one-hour reminder; the destination and due time are derived server-side.",
    scopes: ["discord:reminders"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/reminders/jobs/claim",
    summary: "Body { workerId, limit }. Leases due reminder jobs for delivery.",
    scopes: ["discord:reminders"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/reminders/jobs/[id]/ack",
    summary:
      "Body { leaseToken, status, discordMessageId?, errorCode?, errorMessage? }. Completes or retries a leased reminder job.",
    scopes: ["discord:reminders"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/message-events",
    summary:
      "Body { events: [...] }. Idempotently stores up to 25 Creator/VIP message snapshots, edits, or deletions and returns the server-resolved before/after state. Bot, webhook, and configured admin-group messages are excluded.",
    scopes: ["discord:message-events"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/deposit-settings",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId }. Returns independent automatic sign-up and deposit notification settings for the linked creator section and its current logs channel.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/deposit-settings/update",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId, interactionId, target?, enabled }. Independently enables or disables future sign-up or deposit notifications for the linked creator section. Omitting target preserves the legacy combined update. Writes only audited settings and delivery state in the admin database.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-deposits/jobs/claim",
    summary:
      "Body { guildId, workerId, limit }. Discovers creator-attributed deposits and sign-ups and leases bounded batches of durable Discord delivery jobs.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-deposits/jobs/[id]/ack",
    summary:
      "Body { guildId, leaseToken, status, discordMessageId?, errorCode?, errorMessage? }. Acknowledges a creator deposit notification as delivered or returns it to bounded retry handling.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-signups/jobs/[id]/ack",
    summary:
      "Body { leaseToken, status, discordMessageId?, errorCode?, errorMessage? }. Acknowledges a creator signup notification or returns it to bounded retry handling.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/claim",
    summary:
      "Body { discordUserId, claimableId }. Files a claim request for a creator VIP wager reward (the `vip_*` ids returned by /discord/rewards). Eligibility is recomputed server-side — the caller never supplies an amount. Creates a PENDING row for staff review; no balance moves until a human approves.",
    scopes: ["discord:rewards:claim"],
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

/**
 * INTERNAL routes — the dashboard's own endpoints under `src/app/api/`.
 *
 * These are NOT part of the key-authenticated surface: an API key will not
 * open any of them. They authenticate with the admin session cookie (i.e. a
 * signed-in browser) or a deploy secret, and exist to serve this app's own UI.
 * Listed purely so the full HTTP surface is visible in one place.
 */
export type InternalEndpointAuth = "admin session" | "cron secret";

export type InternalEndpoint = {
  method: ApiEndpointMethod;
  path: string;
  summary: string;
  auth: InternalEndpointAuth;
};

export const INTERNAL_ENDPOINTS: readonly InternalEndpoint[] = [
  {
    method: "GET",
    path: "/api/admin/avatar/[id]",
    summary: "Serves an admin user's avatar image.",
    auth: "admin session",
  },
  {
    method: "GET",
    path: "/api/health/postgres",
    summary: "PostgreSQL health probe. No in-app caller — external monitoring only.",
    auth: "cron secret",
  },
  {
    method: "GET",
    path: "/api/imagekit-auth",
    summary: "Short-lived ImageKit upload token for the client uploader.",
    auth: "admin session",
  },
  {
    method: "GET",
    path: "/api/packy-live",
    summary: "SSE proxy for the packy.gg live WebSocket (chat + activity).",
    auth: "admin session",
  },
  {
    method: "POST",
    path: "/api/users/export",
    summary: "Generates the filtered users CSV (contains PII — capability-gated).",
    auth: "admin session",
  },
  {
    method: "GET",
    path: "/api/cron/warm",
    summary:
      "Keep-warm cron: pings PostgreSQL and refreshes the hottest cached aggregates.",
    auth: "cron secret",
  },
];
