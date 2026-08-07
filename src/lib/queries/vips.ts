import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/drizzle";
import { getReadDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { VIPS_GUILD_ID } from "@/lib/discord-vip-channel-links";
import { calculateUsersPnlBatch } from "./pnl";

/**
 * Players → VIPs data layer.
 *
 * Everything here reads the ADMIN DB (`admin_user_tags`,
 * `discord_vip_channel_links`, `discord_vip_channel_link_operations`) and
 * hydrates player identity from MAIN with a single PK-IN lookup — never a
 * cross-DB join.
 *
 * Query shapes / indexes:
 *  • roster        → `admin_user_tags_tag_idx` (tag = 'vip'), LEFT JOIN on
 *    `discord_vip_channel_links_guild_user_unique` (guild_id, user_id).
 *  • operations    → `discord_vip_channel_link_operations_created_idx`
 *    (created_at DESC) with a hard LIMIT.
 *  • stats         → counting aggregates over the same two small
 *    admin-side tables (VIP-scale row counts, no user/ledger scan).
 * The heavy leg is the MAIN-side lifetime P&L batch, and it stays bounded
 * to the current page slice, exactly like `/users` and `getUsersWithTags`.
 */

export type VipDiscordLink = {
  guildId: string;
  channelId: string;
  memberDiscordUserId: string | null;
  linkedByDiscordUserId: string;
  linkedAt: string;
  updatedAt: string;
};

export type VipRosterRow = {
  userId: string;
  username: string | null;
  email: string | null;
  /** Profile picture URL from MAIN `user.image`; null when unset. */
  image: string | null;
  country: string | null;
  countryCode: string | null;
  taggedAt: string;
  setByAdminUsername: string | null;
  /**
   * User-perspective lifetime P&L (positive = user in profit = house
   * liability → 🔴 rose; negative = user is down → 🟢 emerald), same sign
   * convention as `/users` and `getUsersWithTags`.
   */
  pnl: number | null;
  totalDeposited: number | null;
  totalWithdrawn: number | null;
  /** Lifetime lossback credited by admins (`lossback` adjustments). */
  lossbackGiven: number;
  /** Lifetime manual bonus credited by admins (`bonus` + `deposit_bonus`). */
  bonusGiven: number;
  discord: VipDiscordLink | null;
};

export type VipRosterFilter = "all" | "linked" | "unlinked";

export type VipLinkOperationStatus = "linked" | "updated" | "already_linked";

export type VipLinkOperationRow = {
  interactionId: string;
  guildId: string;
  userId: string;
  username: string | null;
  channelId: string;
  memberDiscordUserId: string | null;
  actorDiscordUserId: string;
  status: VipLinkOperationStatus;
  vipTagAdded: boolean;
  createdAt: string;
};

export type VipOrphanLinkRow = {
  userId: string;
  username: string | null;
  channelId: string;
  memberDiscordUserId: string | null;
  updatedAt: string;
};

export type VipBotStats = {
  /** VIP-tagged players (admin tag, regardless of Discord state). */
  vipTotal: number;
  /** VIP channel links that exist in the VIP guild. */
  linkedTotal: number;
  /** Links that also carry the Discord member id (bot can grant the role). */
  memberLinkedTotal: number;
  /** VIP-tagged players with no channel link yet. */
  unlinkedTotal: number;
  /** Channel links whose player no longer carries the VIP tag. */
  orphanLinkTotal: number;
  /** Bot link operations in the last 7 days. */
  operations7d: number;
  /** Most recent bot link operation, ISO — null when the bot never ran. */
  lastOperationAt: string | null;
};

type RosterDbRow = {
  target_user_id: string;
  created_at: string;
  set_by_username: string | null;
  channel_id: string | null;
  member_discord_user_id: string | null;
  linked_by_discord_user_id: string | null;
  linked_at: string | null;
  link_updated_at: string | null;
};

/** MAIN-side identity hydration for a bounded set of player ids. */
async function hydrateUsers(userIds: string[]) {
  if (userIds.length === 0) {
    return new Map<
      string,
      {
        id: string;
        username: string | null;
        email: string | null;
        image: string | null;
        country: string | null;
        country_code: string | null;
      }
    >();
  }
  const db = await getReadDrizzleDb();
  const { rows } = await db.execute<{
    id: string;
    username: string | null;
    email: string | null;
    image: string | null;
    country: string | null;
    country_code: string | null;
  }>(sql`
    SELECT id, username, email, image, country, country_code
    FROM "user"
    WHERE id = ANY(${pgArrayParam(userIds)}::text[])
  `);
  return new Map(rows.map((r) => [r.id, r]));
}

type AdjustmentTotals = { lossback: number; bonus: number };

/**
 * Lifetime admin-adjustment credits per player, split into the two lines
 * the VIP desk cares about:
 *   • `lossback` → `metadata.adjustment_category = 'lossback'`
 *   • `bonus`    → `bonus` + `deposit_bonus` (both manual bonus credits)
 *
 * Both are CREDITS only (`amount > 0`, money the house gave the player) —
 * a categorized debit clawback is a house gain and must never net against
 * what was handed out. Categories are the canonical keys written by
 * `adjustBalance` (see `@/lib/balance-adjustment-categories`).
 *
 * Bounded to the current page slice and served by
 * `idx_ledger_tx_user_type_status_created_at` (user_id, type, status).
 */
async function getAdjustmentTotals(
  userIds: string[],
): Promise<Map<string, AdjustmentTotals>> {
  const totals = new Map<string, AdjustmentTotals>();
  if (userIds.length === 0) return totals;

  const db = await getReadDrizzleDb();
  const { rows } = await db.execute<{
    user_id: string;
    lossback: string;
    bonus: string;
  }>(sql`
    SELECT
      lt.user_id,
      COALESCE(SUM(CASE
        WHEN lt.metadata->>'adjustment_category' = 'lossback'
        THEN lt.amount::numeric ELSE 0 END), 0)::text AS lossback,
      COALESCE(SUM(CASE
        WHEN lt.metadata->>'adjustment_category' IN ('bonus', 'deposit_bonus')
        THEN lt.amount::numeric ELSE 0 END), 0)::text AS bonus
    FROM ledger_transactions lt
    WHERE lt.user_id = ANY(${pgArrayParam(userIds)}::text[])
      AND lt.type = 'admin_balance_adjustment'::ledger_transaction_type
      AND lt.status = 'completed'::ledger_transaction_status
      AND lt.amount::numeric > 0
    GROUP BY lt.user_id
  `);
  for (const row of rows) {
    totals.set(row.user_id, {
      lossback: Number(row.lossback),
      bonus: Number(row.bonus),
    });
  }
  return totals;
}

/**
 * Paginated VIP roster with the Discord channel link folded in.
 *
 * `filter` narrows on the presence of a link in the VIP guild, so the
 * "Not linked" tab is a real server-side filter (correct `total`,
 * correct pagination) rather than a client-side slice of one page.
 */
export async function getVipRoster({
  limit,
  offset,
  filter = "all",
}: {
  limit: number;
  offset: number;
  filter?: VipRosterFilter;
}): Promise<{ items: VipRosterRow[]; total: number }> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const safeOffset = Math.max(0, offset);
  const linkFilter =
    filter === "linked"
      ? sql`AND l.channel_id IS NOT NULL`
      : filter === "unlinked"
        ? sql`AND l.channel_id IS NULL`
        : sql``;

  const [rosterResult, totalResult] = await Promise.all([
    adminDrizzle.execute<RosterDbRow>(sql`
      SELECT
        t.target_user_id,
        t.created_at,
        a.username AS set_by_username,
        l.channel_id,
        l.member_discord_user_id,
        l.linked_by_discord_user_id,
        l.created_at AS linked_at,
        l.updated_at AS link_updated_at
      FROM admin_user_tags t
      LEFT JOIN admin_users a ON a.id = t.set_by_admin_id
      LEFT JOIN discord_vip_channel_links l
        ON l.user_id = t.target_user_id
       AND l.guild_id = ${VIPS_GUILD_ID}
      WHERE t.tag = 'vip'
      ${linkFilter}
      ORDER BY t.created_at DESC
      LIMIT ${safeLimit}
      OFFSET ${safeOffset}
    `),
    adminDrizzle.execute<{ value: string | number }>(sql`
      SELECT COUNT(*) AS value
      FROM admin_user_tags t
      LEFT JOIN discord_vip_channel_links l
        ON l.user_id = t.target_user_id
       AND l.guild_id = ${VIPS_GUILD_ID}
      WHERE t.tag = 'vip'
      ${linkFilter}
    `),
  ]);

  const rows = rosterResult.rows;
  const total = Number(totalResult.rows[0]?.value ?? 0);
  if (rows.length === 0) return { items: [], total };

  const userIds = rows.map((r) => r.target_user_id);
  const [userById, pnlByUserId, adjustmentsByUserId] = await Promise.all([
    hydrateUsers(userIds),
    calculateUsersPnlBatch(userIds),
    getAdjustmentTotals(userIds),
  ]);

  return {
    items: rows.map((r) => {
      const player = userById.get(r.target_user_id);
      const userPnl = pnlByUserId.get(r.target_user_id) ?? null;
      const adjustments = adjustmentsByUserId.get(r.target_user_id);
      return {
        userId: r.target_user_id,
        username: player?.username ?? null,
        email: player?.email ?? null,
        image: player?.image ?? null,
        country: player?.country ?? null,
        countryCode: player?.country_code ?? null,
        taggedAt: new Date(r.created_at).toISOString(),
        setByAdminUsername: r.set_by_username,
        // House formula → user-perspective sign (see `getUsersWithTags`).
        pnl: userPnl ? -userPnl.pnl : null,
        totalDeposited: userPnl?.deposits ?? null,
        totalWithdrawn: userPnl?.withdrawals ?? null,
        lossbackGiven: adjustments?.lossback ?? 0,
        bonusGiven: adjustments?.bonus ?? 0,
        discord: r.channel_id
          ? {
              guildId: VIPS_GUILD_ID,
              channelId: r.channel_id,
              memberDiscordUserId: r.member_discord_user_id,
              linkedByDiscordUserId: r.linked_by_discord_user_id ?? "",
              linkedAt: new Date(r.linked_at ?? r.created_at).toISOString(),
              updatedAt: new Date(
                r.link_updated_at ?? r.linked_at ?? r.created_at,
              ).toISOString(),
            }
          : null,
      };
    }),
    total,
  };
}

/** Counters for the VIP + bot KPI strip. Admin-DB only, no MAIN read. */
export async function getVipBotStats(): Promise<VipBotStats> {
  const { rows } = await adminDrizzle.execute<{
    vip_total: string | number;
    linked_total: string | number;
    member_linked_total: string | number;
    unlinked_total: string | number;
    orphan_link_total: string | number;
    operations_7d: string | number;
    last_operation_at: string | null;
  }>(sql`
    SELECT
      (SELECT COUNT(*) FROM admin_user_tags WHERE tag = 'vip') AS vip_total,
      (SELECT COUNT(*) FROM discord_vip_channel_links
        WHERE guild_id = ${VIPS_GUILD_ID}) AS linked_total,
      (SELECT COUNT(*) FROM discord_vip_channel_links
        WHERE guild_id = ${VIPS_GUILD_ID}
          AND member_discord_user_id IS NOT NULL) AS member_linked_total,
      (SELECT COUNT(*) FROM admin_user_tags t
        WHERE t.tag = 'vip'
          AND NOT EXISTS (
            SELECT 1 FROM discord_vip_channel_links l
            WHERE l.guild_id = ${VIPS_GUILD_ID}
              AND l.user_id = t.target_user_id
          )) AS unlinked_total,
      (SELECT COUNT(*) FROM discord_vip_channel_links l
        WHERE l.guild_id = ${VIPS_GUILD_ID}
          AND NOT EXISTS (
            SELECT 1 FROM admin_user_tags t
            WHERE t.tag = 'vip'
              AND t.target_user_id = l.user_id
          )) AS orphan_link_total,
      (SELECT COUNT(*) FROM discord_vip_channel_link_operations
        WHERE created_at >= NOW() - INTERVAL '7 days') AS operations_7d,
      (SELECT MAX(created_at) FROM discord_vip_channel_link_operations)
        AS last_operation_at
  `);
  const row = rows[0];
  return {
    vipTotal: Number(row?.vip_total ?? 0),
    linkedTotal: Number(row?.linked_total ?? 0),
    memberLinkedTotal: Number(row?.member_linked_total ?? 0),
    unlinkedTotal: Number(row?.unlinked_total ?? 0),
    orphanLinkTotal: Number(row?.orphan_link_total ?? 0),
    operations7d: Number(row?.operations_7d ?? 0),
    lastOperationAt: row?.last_operation_at
      ? new Date(row.last_operation_at).toISOString()
      : null,
  };
}

/**
 * Most recent `/link` interactions the bot recorded. Bounded by `limit`
 * and served straight off the `created_at DESC` index; usernames are
 * hydrated from MAIN in one PK-IN lookup.
 */
export async function getVipLinkOperations(
  limit = 20,
): Promise<VipLinkOperationRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const { rows } = await adminDrizzle.execute<{
    interaction_id: string;
    guild_id: string;
    user_id: string;
    channel_id: string;
    member_discord_user_id: string | null;
    actor_discord_user_id: string;
    status: VipLinkOperationStatus;
    vip_tag_added: boolean;
    created_at: string;
  }>(sql`
    SELECT
      interaction_id, guild_id, user_id, channel_id,
      member_discord_user_id, actor_discord_user_id,
      status, vip_tag_added, created_at
    FROM discord_vip_channel_link_operations
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `);
  if (rows.length === 0) return [];

  const userById = await hydrateUsers([...new Set(rows.map((r) => r.user_id))]);
  return rows.map((r) => ({
    interactionId: r.interaction_id,
    guildId: r.guild_id,
    userId: r.user_id,
    username: userById.get(r.user_id)?.username ?? null,
    channelId: r.channel_id,
    memberDiscordUserId: r.member_discord_user_id,
    actorDiscordUserId: r.actor_discord_user_id,
    status: r.status,
    vipTagAdded: r.vip_tag_added,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Channel links whose player no longer carries the VIP tag — i.e. the tag
 * was removed in the admin after the bot linked the channel. The Discord
 * channel is still bound, so this is an action list, not a metric.
 */
export async function getVipOrphanLinks(
  limit = 20,
): Promise<VipOrphanLinkRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const { rows } = await adminDrizzle.execute<{
    user_id: string;
    channel_id: string;
    member_discord_user_id: string | null;
    updated_at: string;
  }>(sql`
    SELECT l.user_id, l.channel_id, l.member_discord_user_id, l.updated_at
    FROM discord_vip_channel_links l
    WHERE l.guild_id = ${VIPS_GUILD_ID}
      AND NOT EXISTS (
        SELECT 1 FROM admin_user_tags t
        WHERE t.tag = 'vip' AND t.target_user_id = l.user_id
      )
    ORDER BY l.updated_at DESC
    LIMIT ${safeLimit}
  `);
  if (rows.length === 0) return [];

  const userById = await hydrateUsers([...new Set(rows.map((r) => r.user_id))]);
  return rows.map((r) => ({
    userId: r.user_id,
    username: userById.get(r.user_id)?.username ?? null,
    channelId: r.channel_id,
    memberDiscordUserId: r.member_discord_user_id,
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}
