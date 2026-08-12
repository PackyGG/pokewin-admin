import "server-only";

import { sql, type SQL } from "drizzle-orm";

import {
  ANTIFRAUD_TEAM_IDS,
  APPROVED_DISCORD_CATEGORY_IDS,
  DISCORD_MENTION_GROUPS,
  SILENT_DISCORD_CATEGORY_IDS,
} from "./antifraud-policy";

function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/**
 * The category allowlist as a parameterised `IN (...)` list, so adding a
 * category is a one-line change in `antifraud-policy.ts` instead of an edit in
 * every routing query.
 */
export function approvedCategoryIds(): SQL {
  return idList(APPROVED_DISCORD_CATEGORY_IDS);
}

export function silentCategoryIds(): SQL {
  return idList(SILENT_DISCORD_CATEGORY_IDS);
}

/**
 * The group -> Discord user id membership as parameterised `VALUES` rows, for
 * joining against `discord_notification_channel_mentions.group_key`.
 *
 * Membership stays a reviewed code fact in `ANTIFRAUD_TEAM_IDS`; only the
 * per-channel SELECTION is stored in the database. That means a teammate is
 * added or removed in one place and every channel that selected the group picks
 * the change up on its next alert, with no data migration.
 */
export function mentionGroupMemberRows(): SQL {
  const rows = DISCORD_MENTION_GROUPS.flatMap((group) =>
    ANTIFRAUD_TEAM_IDS[group.key].map(
      (userId) => sql`(${group.key}, ${userId})`,
    ),
  );
  return sql.join(rows, sql`, `);
}

/** Parameterised `VALUES` rows for a non-empty event recipient override. */
export function mentionGroupKeyRows(groupKeys: readonly string[]): SQL {
  if (groupKeys.length === 0) {
    throw new Error("A Discord mention-group override cannot be empty.");
  }
  return sql.join(groupKeys.map((groupKey) => sql`(${groupKey})`), sql`, `);
}
