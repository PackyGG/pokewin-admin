import "server-only";

import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { getReadDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { communityLevelForXp } from "@/lib/discord-community-xp";
import { communityRankForLevel } from "@/lib/discord-community-ranks";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { CUSTOMER_EXCLUDED_ROLES } from "@/lib/metrics/scope";
import { CHAT_RAFFLE_MAX_ENTRIES } from "./config";
import { compareLeaderboardCandidates } from "./leaderboard";

/**
 * standings.ts — turn canonical Community XP into raffle tickets.
 *
 * XP decisions live in the ADMIN DB and already apply the shared 15 XP award,
 * quality, cooldown and duplicate rules to both Discord and on-site chat.
 * This scorer aggregates awarded events inside the round window, then uses a
 * bounded MAIN read to resolve linked Packy users and enforce player-only
 * eligibility. One awarded XP is one raffle ticket.
 *
 * ─── Index safety ────────────────────────────────────────────────────────
 *
 * `discord_community_xp_events_time_idx` serves the bounded ADMIN event scan.
 * MAIN is queried only for the Discord ids that actually earned XP in that
 * window; it is never scanned for chat history.
 *
 * ─── Eligibility is NOT optional ─────────────────────────────────────────
 *
 * Staff/admins/creators, blacklisted users and muted users are ALWAYS
 * excluded (see CHAT_RAFFLE_FIXED_RULES in ./config.ts). These were per-round
 * toggles until the owner removed them: no legitimate round wants staff
 * winning a player raffle, and a muted user cannot chat anyway. There is no
 * code path here that skips them.
 *
 * Unlinked Discord users cannot enter because there is no Packy user to pay.
 */

export type ChatRaffleStanding = {
  userId: string;
  username: string | null;
  image: string | null;
  role: string;
  discordUserId: string;
  messageCount: number;
  /** XP earned from Discord messages inside this round. */
  discordXp: number;
  discordMessageCount: number;
  /** XP earned from linked on-site chat messages inside this round. */
  siteChatXp: number;
  siteChatMessageCount: number;
  /** Discord XP + site-chat XP inside this round. */
  basePoints: number;
  /** Signed total of the operator's manual corrections. */
  adjustmentPoints: number;
  /** basePoints + adjustmentPoints. */
  points: number;
  /** 1 point = 1 ticket. */
  tickets: number;
  position: number;
  /** Share of the total ticket pool, 0–1. */
  winChance: number;
  /** Lifetime combined Community XP at render/draw time. */
  communityTotalXp: number;
  communityLevel: number;
  communityRankName: string;
  /** Last qualifying award in the window; earlier wins an equal-XP tie. */
  scoreReachedAt: string | null;
};

export type ChatRaffleStandings = {
  standings: ChatRaffleStanding[];
  totalTickets: number;
  entrants: number;
  /**
   * True when more eligible users existed than CHAT_RAFFLE_MAX_ENTRIES. Never
   * silently swallowed — the page surfaces it and the draw refuses to run.
   */
  truncated: boolean;
};

type XpRow = {
  discord_user_id: string;
  discord_xp: number;
  site_chat_xp: number;
  discord_message_count: number;
  site_chat_message_count: number;
  message_count: number;
  community_total_xp: number;
  score_reached_at: string | null;
};

type LinkedUserRow = {
  discord_user_id: string;
  user_id: string;
  username: string | null;
  image: string | null;
  role: string;
};

/**
 * Aggregate every eligible Community XP earner in the window and turn their
 * awarded XP into tickets.
 *
 * `adjustments` maps user_id → signed point delta (the operator's manual
 * corrections for this round). Applied AFTER the chat score, so a correction
 * can knock a farmer out of the draw entirely by taking them to zero.
 */
export async function getChatRaffleStandings(params: {
  startsAt: Date;
  endsAt: Date;
  adjustments?: Map<string, number>;
  limit?: number;
  timeframe?: "window" | "lifetime";
}): Promise<ChatRaffleStandings> {
  const { startsAt, endsAt } = params;
  const timeframe = params.timeframe ?? "window";
  const adjustments = params.adjustments ?? new Map<string, number>();
  const limit = Math.min(params.limit ?? CHAT_RAFFLE_MAX_ENTRIES, CHAT_RAFFLE_MAX_ENTRIES);

  if (!(endsAt > startsAt)) {
    return { standings: [], totalTickets: 0, entrants: 0, truncated: false };
  }

  const xpResult = timeframe === "lifetime"
    ? await adminDrizzle.execute<XpRow>(sql`
        SELECT discord_user_id,
          discord_xp::int,
          site_chat_xp::int,
          discord_counted_messages::int AS discord_message_count,
          site_chat_counted_messages::int AS site_chat_message_count,
          counted_messages::int AS message_count,
          total_xp::int AS community_total_xp,
          NULL::timestamptz AS score_reached_at
        FROM discord_community_xp_profiles
        WHERE total_xp > 0
      `)
    : await adminDrizzle.execute<XpRow>(sql`
        SELECT
          event.discord_user_id,
          coalesce(sum(event.awarded_xp) FILTER (WHERE event.source = 'discord'), 0)::int AS discord_xp,
          coalesce(sum(event.awarded_xp) FILTER (WHERE event.source = 'site_chat'), 0)::int AS site_chat_xp,
          count(*) FILTER (WHERE event.source = 'discord')::int AS discord_message_count,
          count(*) FILTER (WHERE event.source = 'site_chat')::int AS site_chat_message_count,
          count(*)::int AS message_count,
          profile.total_xp::int AS community_total_xp,
          max(event.occurred_at) AS score_reached_at
        FROM discord_community_xp_events event
        JOIN discord_community_xp_profiles profile
          ON profile.discord_user_id = event.discord_user_id
        WHERE event.awarded_xp > 0
          AND event.occurred_at >= ${startsAt.toISOString()}::timestamptz
          AND event.occurred_at < ${endsAt.toISOString()}::timestamptz
        GROUP BY event.discord_user_id, profile.total_xp
      `);
  if (xpResult.rows.length === 0) {
    return { standings: [], totalTickets: 0, entrants: 0, truncated: false };
  }

  const excluded = await getExcludedUserIds();
  const blacklistFilter =
    excluded.length > 0
      ? sql`AND u.id <> ALL(${pgArrayParam(excluded)}::text[])`
      : sql``;
  const roleFilter = sql`u.role::text <> ALL(${pgArrayParam([...CUSTOMER_EXCLUDED_ROLES])}::text[])`;

  const db = await getReadDrizzleDb();
  const linkedResult = await db.execute<LinkedUserRow>(sql`
    SELECT account."accountId" AS discord_user_id,
      u.id AS user_id, u.username, u.image, u.role::text AS role
    FROM account
    JOIN "user" u ON u.id = account."userId"
    WHERE account."providerId" = 'discord'
      AND account."accountId" = ANY(${pgArrayParam(xpResult.rows.map((row) => row.discord_user_id))}::text[])
      AND ${roleFilter}
      ${blacklistFilter}
      AND NOT EXISTS (
        SELECT 1 FROM user_mutes um
        WHERE um.user_id = u.id
          AND um.unmuted_at IS NULL
          AND (um.expires_at IS NULL OR um.expires_at > (now() AT TIME ZONE 'utc'))
      )
  `);
  const linkedByDiscordId = new Map(
    linkedResult.rows.map((row) => [row.discord_user_id, row]),
  );

  // Fold in the manual adjustments, then drop anyone left on zero or less —
  // a 0-ticket entry can't win, and leaving it in would pad the standings
  // with entrants who have no stake in the draw.
  //
  // A user with ONLY an adjustment (never chatted) is deliberately not
  // resurrected here: the adjustment corrects a chatter's score, it is not a
  // back door for entering someone who never took part.
  const scoredEntries = xpResult.rows
    .flatMap((xp) => {
      const user = linkedByDiscordId.get(xp.discord_user_id);
      if (!user) return [];
      const basePoints = xp.discord_xp + xp.site_chat_xp;
      const adjustmentPoints = adjustments.get(user.user_id) ?? 0;
      const communityLevel = communityLevelForXp(xp.community_total_xp);
      return {
        userId: user.user_id,
        username: user.username,
        image: user.image,
        role: user.role,
        discordUserId: xp.discord_user_id,
        messageCount: xp.message_count,
        discordXp: xp.discord_xp,
        discordMessageCount: xp.discord_message_count,
        siteChatXp: xp.site_chat_xp,
        siteChatMessageCount: xp.site_chat_message_count,
        basePoints,
        adjustmentPoints,
        points: Math.max(0, basePoints + adjustmentPoints),
        communityTotalXp: xp.community_total_xp,
        communityLevel,
        communityRankName: communityRankForLevel(communityLevel).name,
        scoreReachedAt: xp.score_reached_at
          ? new Date(xp.score_reached_at).toISOString()
          : null,
      };
    })
    .filter((e) => e.points > 0)
    // Re-sort: a negative adjustment can reorder the raw SQL ranking.
    .sort(compareLeaderboardCandidates);

  const truncated = scoredEntries.length > limit;
  const capped = truncated ? scoredEntries.slice(0, limit) : scoredEntries;
  const totalTickets = capped.reduce((sum, e) => sum + e.points, 0);

  return {
    standings: capped.map((e, i) => ({
      ...e,
      tickets: e.points,
      position: i + 1,
      winChance: totalTickets > 0 ? e.points / totalTickets : 0,
    })),
    totalTickets,
    entrants: capped.length,
    truncated,
  };
}
