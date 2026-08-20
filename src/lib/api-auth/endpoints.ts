import { API_SCOPES, type ApiScope } from "./scopes";

/**
 * Machine-checked catalogue of every endpoint on the `/api/v1/*` surface.
 * Nothing secret lives here; guardrail tests use it as the API contract.
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
    path: "/api/v1/discord/creator-setups/delete-preview",
    summary:
      "Body { guildId, creatorDiscordUserId, actorDiscordUserId }. Authorized Discord setup admins only. Returns the exact active category/chat/logs IDs that the bot must confirm and remove before unlinking the setup.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/delete",
    summary:
      "Body { guildId, creatorDiscordUserId, categoryId, chatChannelId, logsChannelId, actorDiscordUserId, interactionId }. Authorized Discord setup admins only. Compare-and-swap soft-deletes and unlinks the exact active setup after Discord cleanup while preserving its historical channel snapshot and audit trail. Returns { deleted: true }.",
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
      "Body { guildId, categoryId, channelId, actorDiscordUserId, periodDays }. periodDays is 7, 14, 30, or null for lifetime (default 7). Returns combined totals and a per-code breakdown for every affiliate code owned by the Packy creator linked to that private Discord section.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/pnl",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId }. Creator or dashboard-admin read of the linked creator's current Admin-owned PnL deal, exact house-cost breakdown, positive-PnL share, and provisional or frozen calculation state.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/conversion",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId }. Creator or dashboard-admin read of the linked creator's active leaderboard deal frame. Returns distinct active users, signups, FTDs, attributed deposits, strictly weighted wager, canonical deal spend, 7.5%-generated value, break-even wager, and conversion ratio.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/stream-events",
    summary: "Body { after }. Returns creator stream lifecycle transitions mapped to their Discord sections for private admin-log delivery, including ending balance and the exact converted-to-real-balance amount (including zero).",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/user-stats",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId, username }. Exact case-insensitive lookup by the public Packy username used in chat and leaderboards. Returns wager, weighted leaderboard wager, deposits, and creator earnings only for the user's current unexpired period on a code owned by the creator linked to that Discord section.",
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
    path: "/api/v1/discord/creator-setups/last-deals",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId }. Creator or dashboard-admin read of the latest one or two started leaderboard deal frames for the linked creator. Weekly and bi-weekly frames use their complete leaderboard window and return signups, FTDs, attributed deposit volume, authoritative weighted wager, top-three standings, and actual fill/tip/sponsorship/payout support.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/casino-sites/catalog",
    summary:
      "Body { guildId }. Creator-server bot-only catalog of active casino names, aliases, owned domains, and token-to-USD conversion rates used to classify external deal data.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-setups/leaderboard",
    summary:
      "Body { guildId, categoryId, channelId, actorDiscordUserId, page, pageSize: 10 }. Returns the active linked creator leaderboard's total prize and one exact standings page. Creator IDs, leaderboard IDs, emails, and internal review markings are omitted.",
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
    path: "/api/v1/discord/creator-deal-approvals/jobs/claim",
    summary:
      "Body { guildId, workerId, limit }. Leases fill, multiplier, P&L, reward, or leaderboard proposals for durable delivery to each proposal's stored private creator chat channel. Jobs expose the immutable proposal under deal, multiplier, pnl, rewards, or leaderboard according to kind.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-deal-approvals/jobs/[id]/ack",
    summary:
      "Body { leaseToken, status, discordMessageId?, errorCode?, errorMessage? }. Records proposal-message delivery or schedules a bounded retry.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-deal-approvals/respond",
    summary:
      "Body { requestId, guildId, categoryId, channelId, messageId, actorDiscordUserId, interactionId, action }. Continue/Approve allow the assigned creator or a linked current site admin; Decline remains creator-only. Every action is bound to the immutable proposal and Discord message.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-deal-approvals/[requestId]/continue",
    summary:
      "Continue action for the assigned creator or a linked current site admin. The request id comes from the route and the body supplies the stored Discord message context and interaction id.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/creator-deal-approvals/[requestId]/decision",
    summary:
      "Approve allows the assigned creator or a linked current site admin; Decline remains creator-only. Both are bound to the proposal's stored guild, category, chat channel, and message.",
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
    path: "/api/v1/discord/vips/perks/sync",
    summary:
      "Body { guildId, cursor?, limit? }. Evaluates a bounded keyset page of linked VIP members and returns each member's desired perk-role state plus the next cursor. Fail-closed when requirements are disabled or invalid.",
    scopes: ["discord:vips:perks"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/vips/perks/status",
    summary:
      "Body { guildId, userId }. Evaluates and returns the backend-authoritative VIP perk entitlement for one linked Packy user.",
    scopes: ["discord:vips:perks"],
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
    method: "POST", path: "/api/v1/discord/community-xp/award",
    summary: "Idempotently awards anti-spam-capped XP for a PackyGG Discord message.",
    scopes: ["discord:community-xp"],
  },
  {
    method: "POST", path: "/api/v1/discord/community-xp/sync-site-chat",
    summary: "Imports linked Packy site-chat messages through a durable cursor.",
    scopes: ["discord:community-xp"],
  },
  {
    method: "POST", path: "/api/v1/discord/community-xp/profile",
    summary: "Returns one combined Discord and Packy chat XP profile.",
    scopes: ["discord:community-xp"],
  },
  {
    method: "POST", path: "/api/v1/discord/community-xp/leaderboard",
    summary: "Returns the combined community XP leaderboard.",
    scopes: ["discord:community-xp"],
  },
  {
    method: "POST", path: "/api/v1/discord/community-xp/roles",
    summary: "Lists, sets, or removes level milestone roles for the official server.",
    scopes: ["discord:community-xp"],
  },
  {
    method: "POST", path: "/api/v1/discord/community-xp/role-sync",
    summary: "Returns paginated levels and configured roles for Discord reconciliation.",
    scopes: ["discord:community-xp"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/moderation-settings",
    summary:
      "Body { guildId }. Returns the PackyGG-only word and Discord invite moderation policy consumed by the bot.",
    scopes: ["discord:message-events"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/prepare",
    summary: "Idempotently reserve one active official-server partnership application before creating its Discord channel.",
    scopes: ["discord:partnership-tickets"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/[ticketId]/complete",
    summary: "Idempotently bind a reserved application to its newly-created ticket channel and initial message.",
    scopes: ["discord:partnership-tickets"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/[ticketId]/cancel",
    summary: "Cancel only an unprovisioned application reservation while preserving its durable lifecycle record.",
    scopes: ["discord:partnership-tickets"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/[ticketId]/actions/prepare",
    summary: "Reserve an idempotent Offer or Close button operation and move the ticket into its pending state.",
    scopes: ["discord:partnership-tickets"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/[ticketId]/actions/[operationId]/complete",
    summary: "Complete an Offer after the category move, or Close only after transcript delivery and channel deletion.",
    scopes: ["discord:partnership-tickets"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/[ticketId]/actions/[operationId]/fail",
    summary: "Record a bounded Discord operation error and safely restore the ticket's previous stable state.",
    scopes: ["discord:partnership-tickets"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/[ticketId]/transcript/batch",
    summary: "Idempotently persist a bounded batch of normalized Discord transcript messages and rich metadata.",
    scopes: ["discord:partnership-tickets"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/[ticketId]/transcript/finalize",
    summary: "Finalize a complete transcript only when the declared and stored message counts match.",
    scopes: ["discord:partnership-tickets"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/[ticketId]/transcript/delivered",
    summary: "Record the transcript attachment message after delivery to the fixed official transcript channel.",
    scopes: ["discord:partnership-tickets"],
  },
  {
    method: "POST", path: "/api/v1/discord/partnership-tickets/recovery",
    summary: "List every nonterminal ticket with form, pending-operation, and transcript state needed for startup repair.",
    scopes: ["discord:partnership-tickets"],
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
      "Body { guildId, workerId, limit }. Discovers creator-attributed deposits and sign-ups, leases bounded batches of durable Discord delivery jobs, and also leases any pending approved-reward-claim jobs.",
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
    path: "/api/v1/discord/creator-reward-claims/jobs/[id]/ack",
    summary:
      "Body { guildId, leaseToken, status, discordMessageId?, errorCode?, errorMessage? }. Acknowledges an approved creator reward claim (FTD lossback, wager milestone, ...) log notification as delivered or returns it to bounded retry handling.",
    scopes: ["discord:creator:setup"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/antifraud/jobs/claim",
    summary:
      "Body { guildId, workerId, limit: 1-25 }. Leases due Antifraud notification jobs for durable delivery to their configured Discord channels.",
    scopes: ["discord:antifraud"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/antifraud/jobs/[id]/ack",
    summary:
      "Body { leaseToken, status: delivered|failed, discordMessageId?, errorCode?, errorMessage? }. Completes a leased Antifraud notification job or returns it to bounded retry handling. The guild is resolved server-side.",
    scopes: ["discord:antifraud"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/antifraud/channel-jobs/claim",
    summary:
      "Body { guildId, workerId, limit: 1-10 }. Leases pending Antifraud channel-creation jobs so the bot can create the missing notification channels.",
    scopes: ["discord:antifraud"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/antifraud/channel-jobs/[id]/ack",
    summary:
      "Body { leaseToken, status: created|failed, channelId?, channelName?, errorCode?, errorMessage? }. Records the created Antifraud channel or returns the job to bounded retry handling. `created` requires channelId and channelName.",
    scopes: ["discord:antifraud"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/antifraud/channels/sync",
    summary:
      "Body { guildId, guildName, channels: [{ id, name, type, parentId, parentName?, position, canView, canSend, canEmbed }] (max 1000), syncedAt }. Replaces the cached Antifraud guild channel list used by the notification routing UI.",
    scopes: ["discord:antifraud"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/claim",
    summary:
      "Body { discordUserId, claimableId }. Files a claim request for a creator VIP wager reward (the `vip_*` ids returned by /discord/rewards). Eligibility is recomputed server-side — the caller never supplies an amount. Creates a PENDING row for staff review; no balance moves until a human approves.",
    scopes: ["discord:rewards:claim"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/rains/jobs/claim",
    summary:
      "Body { workerId, limit }. Discovers active real-money rains whose pool is strictly above $20, durably deduplicates by rain id, and leases pending Discord deliveries.",
    scopes: ["discord:rains"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/rains/jobs/[id]/ack",
    summary:
      "Body { leaseToken, status, discordMessageId?, errorCode?, errorMessage? }. Acknowledges a leased rain notification as delivered or schedules a bounded retry.",
    scopes: ["discord:rains"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/giveaways",
    summary:
      "Creates an idempotent, durable giveaway with an optional linked-Packy-account entry requirement, awaiting initial Discord delivery.",
    scopes: ["discord:giveaways"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/giveaways/[id]/enter",
    summary:
      "Records one unique Discord user entry while active, enforcing the persisted Packy account requirement against the canonical production identity link.",
    scopes: ["discord:giveaways"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/giveaways/[id]/reroll",
    summary:
      "Rerolls all current winners or replaces one named current winner, then queues a durable message update.",
    scopes: ["discord:giveaways"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/giveaways/jobs/claim",
    summary:
      "Finalizes due giveaways in the admin database and leases initial or updated Discord message deliveries.",
    scopes: ["discord:giveaways"],
  },
  {
    method: "POST",
    path: "/api/v1/discord/giveaways/jobs/[id]/ack",
    summary: "Completes or retries a revision-bound giveaway message delivery lease.",
    scopes: ["discord:giveaways"],
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
  {
    method: "GET",
    path: "/api/cron/reward-abuse-detection",
    summary: "Runs the hourly rain reward-abuse detector and batches new reviews into one Discord alert.",
    auth: "cron secret",
  },
];
