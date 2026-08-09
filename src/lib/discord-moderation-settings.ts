import { z } from "zod";

import {
  getAdminSetting,
  SETTINGS_KEYS,
  setAdminSetting,
} from "@/lib/admin-settings";

export const PACKY_DISCORD_GUILD_ID = "1438216946318442683";

const Snowflake = z.string().trim().regex(/^\d{17,20}$/);
const NormalizedText = z.string().trim().min(1).max(120);

export const DiscordModerationSettingsSchema = z.object({
  version: z.literal(1),
  guildId: z.literal(PACKY_DISCORD_GUILD_ID),
  enabled: z.boolean(),
  wordFilterEnabled: z.boolean(),
  inviteFilterEnabled: z.boolean(),
  exemptModerators: z.boolean(),
  blockedWords: z.array(NormalizedText).max(500),
  allowedInviteCodes: z.array(NormalizedText).max(100),
  exemptRoleIds: z.array(Snowflake).max(100),
  exemptChannelIds: z.array(Snowflake).max(100),
}).strict();

export type DiscordModerationSettings = z.infer<
  typeof DiscordModerationSettingsSchema
>;

export const DEFAULT_DISCORD_MODERATION_SETTINGS: DiscordModerationSettings = {
  version: 1,
  guildId: PACKY_DISCORD_GUILD_ID,
  enabled: true,
  wordFilterEnabled: true,
  inviteFilterEnabled: true,
  exemptModerators: true,
  blockedWords: [],
  allowedInviteCodes: [],
  exemptRoleIds: [],
  exemptChannelIds: [],
};

function unique(values: readonly string[], lowerCase: boolean): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = lowerCase ? value.toLocaleLowerCase("en-US") : value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(lowerCase ? key : value);
  }
  return result;
}

export function normalizeDiscordModerationSettings(
  input: unknown,
): DiscordModerationSettings {
  const parsed = DiscordModerationSettingsSchema.parse(input);
  return {
    ...parsed,
    blockedWords: unique(parsed.blockedWords, true),
    allowedInviteCodes: unique(parsed.allowedInviteCodes, true),
    exemptRoleIds: unique(parsed.exemptRoleIds, false),
    exemptChannelIds: unique(parsed.exemptChannelIds, false),
  };
}

export async function getDiscordModerationSettings(): Promise<DiscordModerationSettings> {
  const raw = await getAdminSetting(SETTINGS_KEYS.PACKY_DISCORD_MODERATION);
  if (!raw) return DEFAULT_DISCORD_MODERATION_SETTINGS;
  try {
    return normalizeDiscordModerationSettings(JSON.parse(raw));
  } catch {
    // A malformed value must never turn moderation off silently.
    return DEFAULT_DISCORD_MODERATION_SETTINGS;
  }
}

export async function saveDiscordModerationSettings(
  input: unknown,
  adminUserId: string,
): Promise<DiscordModerationSettings> {
  const settings = normalizeDiscordModerationSettings(input);
  await setAdminSetting(
    SETTINGS_KEYS.PACKY_DISCORD_MODERATION,
    JSON.stringify(settings),
    adminUserId,
  );
  return settings;
}
