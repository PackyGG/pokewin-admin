import "server-only";

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import {
  COMMUNITY_XP_GUILD_ID,
  type CommunityLevelRole,
} from "@/lib/discord-community-ranks";

export { COMMUNITY_XP_GUILD_ID };
export const COMMUNITY_XP_PER_MESSAGE = 15;
export const COMMUNITY_XP_MIN_CHARS = 3;
export const COMMUNITY_XP_COOLDOWN_MIN_SECONDS = 3;
export const COMMUNITY_XP_COOLDOWN_MAX_SECONDS = 10;
export const COMMUNITY_XP_DUPLICATE_MINUTES = 3;

export type CommunityXpSource = "discord" | "site_chat";
export type CommunityXpReason = "awarded" | "too_short" | "low_quality" | "cooldown" | "duplicate" | "daily_cap";

export function communityLevelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100));
}

export function communityXpForLevel(level: number): number {
  const safeLevel = Math.max(0, Math.trunc(level));
  return safeLevel * safeLevel * 100;
}

type ProfileRow = {
  discord_user_id: string;
  total_xp: number;
  discord_xp: number;
  site_chat_xp: number;
  counted_messages: number;
  rank: number;
};

export type CommunityXpProfile = {
  discordUserId: string;
  totalXp: number;
  discordXp: number;
  siteChatXp: number;
  countedMessages: number;
  level: number;
  currentLevelXp: number;
  nextLevelXp: number;
  rank: number;
};

function profileFromRow(row: ProfileRow): CommunityXpProfile {
  const level = communityLevelForXp(row.total_xp);
  return {
    discordUserId: row.discord_user_id,
    totalXp: row.total_xp,
    discordXp: row.discord_xp,
    siteChatXp: row.site_chat_xp,
    countedMessages: row.counted_messages,
    level,
    currentLevelXp: communityXpForLevel(level),
    nextLevelXp: communityXpForLevel(level + 1),
    rank: row.rank,
  };
}

function normalizedContent(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function isLowQualityContent(value: string): boolean {
  const lettersAndNumbers = [...value].filter((character) => /[\p{L}\p{N}]/u.test(character));
  return lettersAndNumbers.length < COMMUNITY_XP_MIN_CHARS
    || new Set(lettersAndNumbers).size < 2;
}

export function communityXpCooldownSeconds(sourceEventId: string): number {
  const range = COMMUNITY_XP_COOLDOWN_MAX_SECONDS - COMMUNITY_XP_COOLDOWN_MIN_SECONDS + 1;
  const value = createHash("sha256").update(sourceEventId).digest()[0] ?? 0;
  return COMMUNITY_XP_COOLDOWN_MIN_SECONDS + (value % range);
}

export async function awardCommunityMessageXp(input: {
  source: CommunityXpSource;
  sourceEventId: string;
  discordUserId: string;
  channelId?: string | null;
  content: string;
  occurredAt: string;
}): Promise<{ awardedXp: number; reason: CommunityXpReason; profile: CommunityXpProfile }> {
  const occurredAt = new Date(input.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("Invalid community XP timestamp.");
  const content = normalizedContent(input.content);
  const contentHash = content
    ? createHash("sha256").update(content).digest("hex")
    : null;

  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`community-xp:${input.discordUserId}`}, 0))`);
    await tx.execute(sql`
      INSERT INTO discord_community_xp_profiles (discord_user_id)
      VALUES (${input.discordUserId}) ON CONFLICT DO NOTHING
    `);
    const existing = await tx.execute<{ awarded_xp: number; reason: CommunityXpReason }>(sql`
      SELECT awarded_xp, reason FROM discord_community_xp_events
      WHERE source = ${input.source} AND source_event_id = ${input.sourceEventId}
    `);
    if (!existing.rows[0]) {
      let reason: CommunityXpReason = "awarded";
      let awardedXp = COMMUNITY_XP_PER_MESSAGE;
      if (content.length < COMMUNITY_XP_MIN_CHARS) {
        reason = "too_short";
        awardedXp = 0;
      } else if (isLowQualityContent(content)) {
        reason = "low_quality";
        awardedXp = 0;
      } else {
        const recent = await tx.execute<{
          last_source_at: string | null;
          last_source_event_id: string | null;
          duplicate: boolean;
        }>(sql`
          SELECT
            (SELECT previous.occurred_at::text FROM discord_community_xp_events previous
              WHERE previous.discord_user_id = ${input.discordUserId}
                AND previous.source = ${input.source} AND previous.awarded_xp > 0
                AND previous.occurred_at <= ${occurredAt.toISOString()}::timestamptz
              ORDER BY previous.occurred_at DESC, previous.id DESC LIMIT 1) AS last_source_at,
            (SELECT previous.source_event_id FROM discord_community_xp_events previous
              WHERE previous.discord_user_id = ${input.discordUserId}
                AND previous.source = ${input.source} AND previous.awarded_xp > 0
                AND previous.occurred_at <= ${occurredAt.toISOString()}::timestamptz
              ORDER BY previous.occurred_at DESC, previous.id DESC LIMIT 1) AS last_source_event_id,
            coalesce(bool_or(content_hash = ${contentHash} AND awarded_xp > 0
              AND occurred_at <= ${occurredAt.toISOString()}::timestamptz
              AND occurred_at > ${occurredAt.toISOString()}::timestamptz - make_interval(mins => ${COMMUNITY_XP_DUPLICATE_MINUTES})), false) AS duplicate
          FROM discord_community_xp_events
          WHERE discord_user_id = ${input.discordUserId}
        `);
        const stats = recent.rows[0];
        const cooldownSeconds = stats?.last_source_event_id
          ? communityXpCooldownSeconds(stats.last_source_event_id)
          : COMMUNITY_XP_COOLDOWN_MIN_SECONDS;
        if (stats?.last_source_at && occurredAt.getTime() - Date.parse(stats.last_source_at) < cooldownSeconds * 1000) {
          reason = "cooldown";
          awardedXp = 0;
        } else if (stats?.duplicate) {
          reason = "duplicate";
          awardedXp = 0;
        }
      }
      await tx.execute(sql`
        INSERT INTO discord_community_xp_events (
          source, source_event_id, discord_user_id, channel_id, content_hash,
          occurred_at, awarded_xp, reason
        ) VALUES (
          ${input.source}, ${input.sourceEventId}, ${input.discordUserId}, ${input.channelId ?? null},
          ${contentHash}, ${occurredAt.toISOString()}, ${awardedXp}, ${reason}
        )
      `);
      if (awardedXp > 0) {
        await tx.execute(sql`
          UPDATE discord_community_xp_profiles SET
            total_xp = total_xp + ${awardedXp},
            discord_xp = discord_xp + ${input.source === "discord" ? awardedXp : 0},
            site_chat_xp = site_chat_xp + ${input.source === "site_chat" ? awardedXp : 0},
            counted_messages = counted_messages + 1,
            updated_at = now()
          WHERE discord_user_id = ${input.discordUserId}
        `);
      }
    }
    const profile = await getCommunityXpProfile(input.discordUserId, tx);
    const event = existing.rows[0] ?? (await tx.execute<{ awarded_xp: number; reason: CommunityXpReason }>(sql`
      SELECT awarded_xp, reason FROM discord_community_xp_events
      WHERE source = ${input.source} AND source_event_id = ${input.sourceEventId}
    `)).rows[0];
    return { awardedXp: event.awarded_xp, reason: event.reason, profile };
  });
}

async function getCommunityXpProfile(
  discordUserId: string,
  executor: Pick<typeof adminDrizzle, "execute"> = adminDrizzle,
): Promise<CommunityXpProfile> {
  const result = await executor.execute<ProfileRow>(sql`
    SELECT profile.*,
      (SELECT count(*)::integer + 1 FROM discord_community_xp_profiles ranked
       WHERE ranked.total_xp > profile.total_xp) AS rank
    FROM discord_community_xp_profiles profile
    WHERE discord_user_id = ${discordUserId}
  `);
  const row = result.rows[0] ?? {
    discord_user_id: discordUserId, total_xp: 0, discord_xp: 0,
    site_chat_xp: 0, counted_messages: 0, rank: 0,
  };
  return profileFromRow(row);
}

export { getCommunityXpProfile };

export async function getCommunityXpLeaderboard(limit = 10): Promise<CommunityXpProfile[]> {
  const result = await adminDrizzle.execute<ProfileRow>(sql`
    SELECT profile.*, rank() OVER (ORDER BY total_xp DESC)::integer AS rank
    FROM discord_community_xp_profiles profile
    ORDER BY total_xp DESC, discord_user_id
    LIMIT ${Math.max(1, Math.min(30, Math.trunc(limit)))}
  `);
  return result.rows.map(profileFromRow);
}

export async function syncSiteChatXp(limit = 200): Promise<{ scanned: number; awarded: number; hasMore: boolean }> {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const cursorResult = await adminDrizzle.execute<{ last_occurred_at: string; last_event_id: string }>(sql`
    INSERT INTO discord_community_xp_cursors (source, last_occurred_at, last_event_id)
    VALUES ('site_chat', now() - interval '5 minutes', '')
    ON CONFLICT (source) DO UPDATE SET source = excluded.source
    RETURNING last_occurred_at::text, last_event_id
  `);
  const cursor = cursorResult.rows[0];
  const prodReadDb = getProdReadDrizzleDb();
  const messages = await prodReadDb.execute<{
    id: string; user_id: string; content: string; created_at: string; discord_user_id: string | null;
  }>(sql`
    SELECT message.id::text, message.user_id, message.content, message.created_at::text,
      discord."accountId" AS discord_user_id
    FROM chat_messages message
    LEFT JOIN account discord ON discord."userId" = message.user_id AND discord."providerId" = 'discord'
    WHERE message.is_deleted = false
      AND (message.created_at, message.id::text) > (${cursor.last_occurred_at}::timestamptz, ${cursor.last_event_id})
    ORDER BY message.created_at, message.id::text
    LIMIT ${safeLimit + 1}
  `);
  const batch = messages.rows.slice(0, safeLimit);
  let awarded = 0;
  for (const message of batch) {
    if (message.discord_user_id) {
      const result = await awardCommunityMessageXp({
        source: "site_chat", sourceEventId: message.id,
        discordUserId: message.discord_user_id, content: message.content,
        occurredAt: new Date(message.created_at).toISOString(),
      });
      if (result.awardedXp > 0) awarded += 1;
    }
  }
  const last = batch.at(-1);
  if (last) {
    await adminDrizzle.execute(sql`
      UPDATE discord_community_xp_cursors SET
        last_occurred_at = ${new Date(last.created_at).toISOString()},
        last_event_id = ${last.id}, updated_at = now()
      WHERE source = 'site_chat'
    `);
  }
  return { scanned: batch.length, awarded, hasMore: messages.rows.length > batch.length };
}

export async function listCommunityLevelRoles(
  guildId: string,
  executor: Pick<typeof adminDrizzle, "execute"> = adminDrizzle,
): Promise<CommunityLevelRole[]> {
  const result = await executor.execute<{ guild_id: string; level: number; role_id: string }>(sql`
    SELECT guild_id, level, role_id FROM discord_community_level_roles
    WHERE guild_id = ${guildId} ORDER BY level
  `);
  return result.rows.map((row) => ({ guildId: row.guild_id, level: row.level, roleId: row.role_id }));
}

export async function setCommunityLevelRole(input: CommunityLevelRole & {
  actorDiscordUserId?: string;
  actorAdminUserId?: string;
}): Promise<CommunityLevelRole[]> {
  if (!input.actorDiscordUserId && !input.actorAdminUserId) throw new Error("A rank-role actor is required.");
  await adminDrizzle.execute(sql`
    INSERT INTO discord_community_level_roles (
      guild_id, level, role_id, created_by_discord_user_id, created_by_admin_user_id
    ) VALUES (
      ${input.guildId}, ${input.level}, ${input.roleId},
      ${input.actorDiscordUserId ?? null}, ${input.actorAdminUserId ?? null}
    )
    ON CONFLICT (guild_id, level) DO UPDATE SET
      role_id = excluded.role_id,
      created_by_discord_user_id = excluded.created_by_discord_user_id,
      created_by_admin_user_id = excluded.created_by_admin_user_id,
      updated_at = now()
  `);
  return listCommunityLevelRoles(input.guildId);
}

export async function replaceCommunityLevelRoles(
  guildId: string,
  roles: Array<{ level: number; roleId: string }>,
  actorAdminUserId: string,
): Promise<CommunityLevelRole[]> {
  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM discord_community_level_roles WHERE guild_id = ${guildId}`);
    for (const role of roles) {
      await tx.execute(sql`
        INSERT INTO discord_community_level_roles (
          guild_id, level, role_id, created_by_admin_user_id
        ) VALUES (${guildId}, ${role.level}, ${role.roleId}, ${actorAdminUserId})
      `);
    }
    return listCommunityLevelRoles(guildId, tx);
  });
}

export async function removeCommunityLevelRole(guildId: string, level: number): Promise<CommunityLevelRole[]> {
  await adminDrizzle.execute(sql`DELETE FROM discord_community_level_roles WHERE guild_id = ${guildId} AND level = ${level}`);
  return listCommunityLevelRoles(guildId);
}

export async function getCommunityRoleSync(guildId: string, afterUserId = "", limit = 100) {
  const [roles, profiles] = await Promise.all([
    listCommunityLevelRoles(guildId),
    adminDrizzle.execute<{ discord_user_id: string; total_xp: number }>(sql`
      SELECT discord_user_id, total_xp FROM discord_community_xp_profiles
      WHERE discord_user_id > ${afterUserId}
      ORDER BY discord_user_id LIMIT ${Math.max(1, Math.min(250, Math.trunc(limit)))}
    `),
  ]);
  return {
    roles,
    profiles: profiles.rows.map((profile) => ({
      discordUserId: profile.discord_user_id,
      level: communityLevelForXp(profile.total_xp),
    })),
  };
}
