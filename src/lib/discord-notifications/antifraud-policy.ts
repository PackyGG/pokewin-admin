export const DISCORD_BOUNDARY_MARKERS = {
  top: "1532206965915390063",
  bottom: "1532206977286017154",
} as const;

export const APPROVED_DISCORD_CATEGORIES = {
  accounts: "1532207307683795026",
  transactions: "1532207461077876766",
  kyc: "1532297417339174922",
  errors: "1532216500444856360",
} as const;

export const APPROVED_DISCORD_CATEGORY_IDS = Object.values(
  APPROVED_DISCORD_CATEGORIES,
);

/**
 * Categories that never ping anyone. Errors and KYC are read-when-you-work-it
 * feeds, so their alerts post silently instead of tagging the team.
 */
export const SILENT_DISCORD_CATEGORY_IDS = [
  APPROVED_DISCORD_CATEGORIES.errors,
  APPROVED_DISCORD_CATEGORIES.kyc,
] as const;

export function isSilentDiscordCategory(categoryId: string | null): boolean {
  return (
    categoryId !== null &&
    (SILENT_DISCORD_CATEGORY_IDS as readonly string[]).includes(categoryId)
  );
}

export const PLANNED_DISCORD_CHANNELS = {
  accounts: [
    "banned-accounts",
    "locked-accounts",
    "account-reviews",
    "kyc-accounts",
    "review-reminders",
  ],
  errors: [
    "third-party-api",
    "discord-command-errors",
    "general",
    "system",
    "code",
    "fail",
    "timeout",
    "webapp-errors",
  ],
} as const;

export const ANTIFRAUD_TEAM_IDS = {
  owner: ["660132586630414338"],
  managers: [
    "276098533629755392",
    "188051599099297802",
    "934854938641715240",
  ],
  dev: ["617341813296070684"],
  support: [
    "1302882250391818311",
    "976564661820481606",
    "620373461256110112",
  ],
} as const;

export type AntifraudTeam = keyof typeof ANTIFRAUD_TEAM_IDS;

/**
 * The mention groups an operator can assign to a channel, in display order.
 *
 * `ANTIFRAUD_TEAM_IDS` stays the single source of the Discord user ids — the
 * per-channel selection in `discord_notification_channel_mentions` stores only
 * group KEYS, never ids, so adding or removing a teammate is one code edit and
 * every channel that selected the group follows automatically.
 *
 * Keys must stay in sync with the CHECK constraint in
 * `drizzle/admin/migrations/20260730_discord_channel_mention_groups.sql`.
 */
export const DISCORD_MENTION_GROUP_KEYS = [
  "owner",
  "managers",
  "dev",
  "support",
] as const satisfies ReadonlyArray<AntifraudTeam>;

export const DISCORD_MENTION_GROUPS = [
  {
    key: "owner",
    label: "Owner",
    description: "Escalation owner. Always added to urgent alerts.",
  },
  {
    key: "managers",
    label: "Manager",
    description: "Shift managers. Always added to urgent alerts.",
  },
  { key: "dev", label: "Developer", description: "On-call engineering." },
  { key: "support", label: "Support", description: "First-line review queue." },
] as const satisfies ReadonlyArray<{
  key: (typeof DISCORD_MENTION_GROUP_KEYS)[number];
  label: string;
  description: string;
}>;

/**
 * Groups added on top of a channel's own selection when a producer marks an
 * alert urgent. This is deliberately NOT operator-editable: a paged incident
 * must not be silenceable by misconfiguring a single channel. It reproduces the
 * pre-existing `alert.urgent` behaviour in `buildDiscordAlertPayload`.
 */
export const DISCORD_ESCALATION_GROUP_KEYS = ["owner", "managers"] as const;

export function isDiscordMentionGroup(
  value: string,
): value is (typeof DISCORD_MENTION_GROUP_KEYS)[number] {
  return (DISCORD_MENTION_GROUP_KEYS as readonly string[]).includes(value);
}

/** Resolves group keys to a deduplicated, order-stable Discord user id list. */
export function discordMentionIds(
  groupKeys: readonly string[],
): readonly string[] {
  const ids = new Set<string>();
  for (const group of DISCORD_MENTION_GROUPS) {
    if (!groupKeys.includes(group.key)) continue;
    for (const id of ANTIFRAUD_TEAM_IDS[group.key]) ids.add(id);
  }
  return [...ids];
}

export const REVIEW_REMINDER_DELAYS_MS = {
  normal: 4.5 * 60 * 60 * 1_000,
  urgent: 60 * 60 * 1_000,
  postponed: 2.5 * 60 * 60 * 1_000,
  sumsubReady: 0,
} as const;

export type AntifraudErrorRoute =
  | "third-party-api"
  | "discord-command-errors"
  | "general"
  | "system"
  | "code"
  | "fail"
  | "timeout"
  | "webapp-errors";

export function antifraudErrorRoute(input: {
  source:
    | "provider"
    | "discord"
    | "general"
    | "system"
    | "code"
    | "failed_action"
    | "timeout"
    | "webapp";
}): AntifraudErrorRoute {
  if (input.source === "provider") return "third-party-api";
  if (input.source === "discord") return "discord-command-errors";
  if (input.source === "webapp") return "webapp-errors";
  if (input.source === "failed_action") return "fail";
  return input.source;
}
export function isApprovedDiscordCategory(categoryId: string | null): boolean {
  return (
    categoryId !== null &&
    (APPROVED_DISCORD_CATEGORY_IDS as readonly string[]).includes(categoryId)
  );
}

export function assertApprovedCategoryBoundary(
  channels: readonly {
    id: string;
    type: string;
    position: number;
  }[],
): void {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const top = byId.get(DISCORD_BOUNDARY_MARKERS.top);
  const bottom = byId.get(DISCORD_BOUNDARY_MARKERS.bottom);
  if (!top || !bottom || top.position >= bottom.position) {
    throw new Error("Discord antifraud category boundary is unavailable.");
  }
  for (const id of APPROVED_DISCORD_CATEGORY_IDS) {
    const category = byId.get(id);
    if (
      !category ||
      category.type !== "category" ||
      category.position <= top.position ||
      category.position >= bottom.position
    ) {
      throw new Error("An approved Discord category is outside its boundary.");
    }
  }
}
