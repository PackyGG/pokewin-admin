import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { VIPS_GUILD_ID } from "@/lib/discord-vip-channel-links";
import {
  evaluateVipPerksPolicy,
  VIP_PERKS_WINDOW_DAYS,
  VIP_PERKS_WINDOW_MS,
  type VipPerksStatus,
} from "@/lib/vip-perks-policy";

const MAX_BATCH_SIZE = 100;

export type VipPerksSettings = {
  enabled: boolean;
  initialWagerWithoutCreatorCodeUsd: number;
  initialWagerWithCreatorCodeUsd: number;
  recurringEnabled: boolean;
  recurringWagerUsd: number | null;
  windowDays: 30;
  updatedAt: string | null;
};

export type VipPerksEntitlement = {
  userId: string;
  discordUserId: string | null;
  channelId: string;
  status: VipPerksStatus;
  active: boolean;
  initialWindowStartedAt: string;
  initialDeadline: string;
  initialUnlockedAt: string | null;
  initialWagerUsd: number;
  initialThresholdUsd: number;
  initialCreatorCodeApplied: boolean;
  currentCycleStartsAt: string | null;
  currentCycleEndsAt: string | null;
  previousCycleWagerUsd: number;
  currentCycleWagerUsd: number;
  recurringThresholdUsd: number | null;
  evaluatedAt: string;
};

type ConfigRow = {
  enabled: boolean;
  initial_wager_usd: string;
  initial_wager_without_creator_code_usd: string;
  initial_wager_with_creator_code_usd: string;
  recurring_enabled: boolean;
  recurring_wager_usd: string | null;
  updated_at: Date | string;
};

type EntitlementRow = {
  link_id: string;
  user_id: string;
  channel_id: string;
  member_discord_user_id: string | null;
  initial_window_started_at: Date | string;
  initial_unlocked_at: Date | string | null;
  initial_threshold_usd: string | null;
  initial_had_creator_code: boolean | null;
  last_initial_wager_usd: string;
  last_status: VipPerksStatus;
  last_active: boolean;
};

type WagerRow = {
  link_id: string;
  initial_wager_usd: string;
  has_active_creator_code: boolean;
  previous_cycle_wager_usd: string;
  current_cycle_wager_usd: string;
};

export class VipPerksError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VipPerksError";
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function money(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function naiveUtc(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function settingsFromRow(row?: ConfigRow): VipPerksSettings {
  return {
    enabled: row?.enabled ?? false,
    initialWagerWithoutCreatorCodeUsd: money(
      row?.initial_wager_without_creator_code_usd ?? row?.initial_wager_usd,
    ),
    initialWagerWithCreatorCodeUsd: money(
      row?.initial_wager_with_creator_code_usd ?? row?.initial_wager_usd,
    ),
    recurringEnabled: row?.recurring_enabled ?? false,
    recurringWagerUsd:
      row?.recurring_wager_usd == null ? null : money(row.recurring_wager_usd),
    windowDays: VIP_PERKS_WINDOW_DAYS,
    updatedAt: row ? asDate(row.updated_at).toISOString() : null,
  };
}

async function configRow(): Promise<ConfigRow | undefined> {
  const result = await adminDrizzle.execute<ConfigRow>(sql`
    SELECT enabled, initial_wager_usd,
      initial_wager_without_creator_code_usd,
      initial_wager_with_creator_code_usd, recurring_enabled,
      recurring_wager_usd, updated_at
    FROM vip_perks_config
    WHERE guild_id = ${VIPS_GUILD_ID}
    LIMIT 1
  `);
  return result.rows[0];
}

export async function getVipPerksSettings(): Promise<VipPerksSettings> {
  return settingsFromRow(await configRow());
}

function validateSettings(input: {
  enabled: boolean;
  initialWagerWithoutCreatorCodeUsd: number;
  initialWagerWithCreatorCodeUsd: number;
  recurringEnabled: boolean;
  recurringWagerUsd: number | null;
}): void {
  if (
    !Number.isFinite(input.initialWagerWithoutCreatorCodeUsd)
    || input.initialWagerWithoutCreatorCodeUsd <= 0
    || !Number.isFinite(input.initialWagerWithCreatorCodeUsd)
    || input.initialWagerWithCreatorCodeUsd <= 0
  ) {
    throw new VipPerksError(400, "invalid_initial_wager", "Both initial wager tiers must be positive.");
  }
  if (
    input.recurringEnabled
    && (input.recurringWagerUsd == null
      || !Number.isFinite(input.recurringWagerUsd)
      || input.recurringWagerUsd <= 0)
  ) {
    throw new VipPerksError(400, "recurring_wager_required", "Set a positive recurring wager when recurring qualification is enabled.");
  }
}

export async function updateVipPerksSettings(input: {
  enabled: boolean;
  initialWagerWithoutCreatorCodeUsd: number;
  initialWagerWithCreatorCodeUsd: number;
  recurringEnabled: boolean;
  recurringWagerUsd: number | null;
  actorAdminId: string;
}): Promise<VipPerksSettings> {
  validateSettings(input);
  const initialWithoutCode = money(input.initialWagerWithoutCreatorCodeUsd);
  const initialWithCode = money(input.initialWagerWithCreatorCodeUsd);
  const recurring = input.recurringEnabled ? money(input.recurringWagerUsd) : null;
  const result = await adminDrizzle.transaction(async (tx) => {
    const updated = await tx.execute<ConfigRow>(sql`
      INSERT INTO vip_perks_config (
        guild_id, enabled, initial_wager_usd,
        initial_wager_without_creator_code_usd,
        initial_wager_with_creator_code_usd, recurring_enabled,
        recurring_wager_usd, updated_by_admin_id, updated_at
      ) VALUES (
        ${VIPS_GUILD_ID}, ${input.enabled}, ${String(initialWithoutCode)},
        ${String(initialWithoutCode)}, ${String(initialWithCode)},
        ${input.recurringEnabled}, ${recurring == null ? null : String(recurring)},
        ${input.actorAdminId}::uuid, NOW()
      )
      ON CONFLICT (guild_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        initial_wager_usd = EXCLUDED.initial_wager_usd,
        initial_wager_without_creator_code_usd = EXCLUDED.initial_wager_without_creator_code_usd,
        initial_wager_with_creator_code_usd = EXCLUDED.initial_wager_with_creator_code_usd,
        recurring_enabled = EXCLUDED.recurring_enabled,
        recurring_wager_usd = EXCLUDED.recurring_wager_usd,
        updated_by_admin_id = EXCLUDED.updated_by_admin_id,
        updated_at = NOW()
      RETURNING enabled, initial_wager_usd,
        initial_wager_without_creator_code_usd,
        initial_wager_with_creator_code_usd, recurring_enabled,
        recurring_wager_usd, updated_at
    `);
    await tx.execute(sql`
      INSERT INTO admin_audit_events (
        admin_user_id, event_type, metadata
      ) VALUES (
        ${input.actorAdminId}::uuid,
        'vip_perks_settings_updated',
        ${JSON.stringify({
          enabled: input.enabled,
          initialWagerWithoutCreatorCodeUsd: initialWithoutCode,
          initialWagerWithCreatorCodeUsd: initialWithCode,
          recurringEnabled: input.recurringEnabled,
          recurringWagerUsd: recurring,
          windowDays: VIP_PERKS_WINDOW_DAYS,
        })}::jsonb
      )
    `);
    return updated.rows[0];
  });
  return settingsFromRow(result);
}

async function loadEntitlementRows(params: {
  userIds?: readonly string[];
  afterLinkId?: string;
  limit?: number;
}): Promise<EntitlementRow[]> {
  const limit = Math.max(1, Math.min(MAX_BATCH_SIZE + 1, params.limit ?? MAX_BATCH_SIZE));
  const result = await adminDrizzle.execute<EntitlementRow>(sql`
    SELECT l.id AS link_id, l.user_id, l.channel_id,
      l.member_discord_user_id, e.initial_window_started_at,
      e.initial_unlocked_at, e.initial_threshold_usd,
      e.initial_had_creator_code, e.last_initial_wager_usd,
      e.last_status, e.last_active
    FROM discord_vip_channel_links l
    JOIN vip_perk_entitlements e ON e.link_id = l.id
    WHERE l.guild_id = ${VIPS_GUILD_ID}
      AND (${params.userIds == null}
        OR l.user_id = ANY(${pgArrayParam(params.userIds ?? [])}::text[]))
      AND (${params.afterLinkId == null}
        OR l.id > ${params.afterLinkId ?? "00000000-0000-0000-0000-000000000000"}::uuid)
    ORDER BY l.id
    LIMIT ${limit}
  `);
  return result.rows;
}

type WagerWindow = {
  link_id: string;
  user_id: string;
  needs_initial: boolean;
  initial_end: string;
  previous_start: string | null;
  previous_end: string | null;
  current_start: string | null;
  current_end: string | null;
};

async function wagerByWindow(
  rows: readonly EntitlementRow[],
  settings: VipPerksSettings,
  now: Date,
): Promise<Map<string, WagerRow>> {
  if (rows.length === 0) return new Map();
  const windows: WagerWindow[] = rows.map((row) => {
    const start = asDate(row.initial_window_started_at);
    const unlocked = row.initial_unlocked_at ? asDate(row.initial_unlocked_at) : null;
    const frame = evaluateVipPerksPolicy({
      now,
      enabled: settings.enabled,
      initialThresholdUsd: settings.initialWagerWithoutCreatorCodeUsd,
      recurringEnabled: settings.recurringEnabled,
      recurringThresholdUsd: settings.recurringWagerUsd,
      initialWindowStartedAt: start,
      initialUnlockedAt: unlocked,
      initialWagerUsd: 0,
      previousCycleWagerUsd: 0,
      currentCycleWagerUsd: 0,
    });
    return {
      link_id: row.link_id,
      user_id: row.user_id,
      needs_initial: unlocked === null,
      initial_end: naiveUtc(new Date(Math.min(now.getTime(), frame.initialDeadline.getTime()))),
      previous_start: frame.previousCycleStartsAt ? naiveUtc(frame.previousCycleStartsAt) : null,
      previous_end: frame.previousCycleEndsAt ? naiveUtc(frame.previousCycleEndsAt) : null,
      current_start: frame.currentCycleStartsAt ? naiveUtc(frame.currentCycleStartsAt) : null,
      current_end: frame.currentCycleEndsAt
        ? naiveUtc(new Date(Math.min(now.getTime(), frame.currentCycleEndsAt.getTime())))
        : null,
    };
  });
  const result = await getProdReadDrizzleDb().execute<WagerRow>(sql`
    WITH windows AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(windows)}::jsonb) AS x(
        link_id uuid,
        user_id text,
        needs_initial boolean,
        initial_end timestamp,
        previous_start timestamp,
        previous_end timestamp,
        current_start timestamp,
        current_end timestamp
      )
    )
    SELECT
      w.link_id::text AS link_id,
      COALESCE(SUM(COALESCE(g.weighted_bet_amount, g.bet_amount)) FILTER (
        WHERE w.needs_initial AND g.created_at < w.initial_end
      ), 0)::text AS initial_wager_usd,
      COALESCE(
        NULLIF(BTRIM(u.affiliate_code), '') IS NOT NULL
        AND u.affiliate_code_active = true
        AND (u.affiliate_code_expires_at IS NULL OR u.affiliate_code_expires_at > NOW()),
        false
      ) AS has_active_creator_code,
      COALESCE(SUM(COALESCE(g.weighted_bet_amount, g.bet_amount)) FILTER (
        WHERE w.previous_start IS NOT NULL
          AND g.created_at >= w.previous_start AND g.created_at < w.previous_end
      ), 0)::text AS previous_cycle_wager_usd,
      COALESCE(SUM(COALESCE(g.weighted_bet_amount, g.bet_amount)) FILTER (
        WHERE w.current_start IS NOT NULL
          AND g.created_at >= w.current_start AND g.created_at < w.current_end
      ), 0)::text AS current_cycle_wager_usd
    FROM windows w
    LEFT JOIN "user" u ON u.id = w.user_id
    LEFT JOIN game_sessions g
      ON g.user_id = w.user_id
      -- This is the canonical cash-eligible marker set by the game backend:
      -- reward-funded play (rakeback, races, leaderboards, packs, bonuses,
      -- tips, affiliate rewards, and similar grants) is excluded upstream.
      AND g.race_eligible = true
      AND g.currency = 'real'
      AND (
        (w.needs_initial AND g.created_at < w.initial_end)
        OR (w.previous_start IS NOT NULL
          AND g.created_at >= w.previous_start AND g.created_at < w.previous_end)
        OR (w.current_start IS NOT NULL
          AND g.created_at >= w.current_start AND g.created_at < w.current_end)
      )
    GROUP BY w.link_id, u.affiliate_code, u.affiliate_code_active,
      u.affiliate_code_expires_at
  `);
  return new Map(result.rows.map((row) => [row.link_id, row]));
}

function toEntitlement(params: {
  row: EntitlementRow;
  settings: VipPerksSettings;
  wagers: WagerRow | undefined;
  now: Date;
}): VipPerksEntitlement {
  const { row, settings, now } = params;
  const initialWagerUsd = row.initial_unlocked_at
    ? money(row.last_initial_wager_usd)
    : money(params.wagers?.initial_wager_usd);
  const initialCreatorCodeApplied = row.initial_had_creator_code
    ?? params.wagers?.has_active_creator_code
    ?? false;
  const initialThresholdUsd = row.initial_threshold_usd == null
    ? (initialCreatorCodeApplied
        ? settings.initialWagerWithCreatorCodeUsd
        : settings.initialWagerWithoutCreatorCodeUsd)
    : money(row.initial_threshold_usd);
  const previousCycleWagerUsd = money(params.wagers?.previous_cycle_wager_usd);
  const currentCycleWagerUsd = money(params.wagers?.current_cycle_wager_usd);
  const frame = evaluateVipPerksPolicy({
    now,
    enabled: settings.enabled,
    initialThresholdUsd,
    recurringEnabled: settings.recurringEnabled,
    recurringThresholdUsd: settings.recurringWagerUsd,
    initialWindowStartedAt: asDate(row.initial_window_started_at),
    initialUnlockedAt: row.initial_unlocked_at ? asDate(row.initial_unlocked_at) : null,
    initialWagerUsd,
    previousCycleWagerUsd,
    currentCycleWagerUsd,
  });
  return {
    userId: row.user_id,
    discordUserId: row.member_discord_user_id,
    channelId: row.channel_id,
    status: frame.status,
    active: frame.active,
    initialWindowStartedAt: asDate(row.initial_window_started_at).toISOString(),
    initialDeadline: frame.initialDeadline.toISOString(),
    initialUnlockedAt: row.initial_unlocked_at
      ? asDate(row.initial_unlocked_at).toISOString()
      : null,
    initialWagerUsd,
    initialThresholdUsd,
    initialCreatorCodeApplied,
    currentCycleStartsAt: frame.currentCycleStartsAt?.toISOString() ?? null,
    currentCycleEndsAt: frame.currentCycleEndsAt?.toISOString() ?? null,
    previousCycleWagerUsd,
    currentCycleWagerUsd,
    recurringThresholdUsd: settings.recurringEnabled ? settings.recurringWagerUsd : null,
    evaluatedAt: now.toISOString(),
  };
}

async function persistEvaluations(
  rows: readonly EntitlementRow[],
  values: readonly VipPerksEntitlement[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const byUser = new Map(values.map((value) => [value.userId, value]));
  await adminDrizzle.transaction(async (tx) => {
    for (const row of rows) {
      let value = byUser.get(row.user_id);
      if (!value) continue;
      // Serialize state transitions. Two overlapping bot sync/status requests
      // must converge on one unlock and one audit event, not double-log it.
      const lockedResult = await tx.execute<{
        initial_unlocked_at: Date | string | null;
        initial_threshold_usd: string | null;
        initial_had_creator_code: boolean | null;
        last_status: VipPerksStatus;
        last_active: boolean;
      }>(sql`
        SELECT initial_unlocked_at, initial_threshold_usd,
          initial_had_creator_code, last_status, last_active
        FROM vip_perk_entitlements
        WHERE link_id = ${row.link_id}::uuid
        FOR UPDATE
      `);
      const locked = lockedResult.rows[0];
      if (!locked) continue;
      const shouldUnlock =
        !locked.initial_unlocked_at
        && value.status === "active"
        && value.initialWagerUsd >= value.initialThresholdUsd;
      if (shouldUnlock) {
        await tx.execute(sql`
          UPDATE vip_perk_entitlements
          SET initial_unlocked_at = COALESCE(initial_unlocked_at, ${now}),
            initial_threshold_usd = COALESCE(initial_threshold_usd, ${String(value.initialThresholdUsd)}),
            initial_had_creator_code = COALESCE(initial_had_creator_code, ${value.initialCreatorCodeApplied}),
            updated_at = NOW()
          WHERE link_id = ${row.link_id}::uuid
        `);
        row.initial_unlocked_at = now;
        row.initial_threshold_usd = String(value.initialThresholdUsd);
        row.initial_had_creator_code = value.initialCreatorCodeApplied;
        row.last_initial_wager_usd = String(value.initialWagerUsd);
        value = toEntitlement({
          row,
          settings: {
            enabled: true,
            initialWagerWithoutCreatorCodeUsd: value.initialThresholdUsd,
            initialWagerWithCreatorCodeUsd: value.initialThresholdUsd,
            recurringEnabled: value.recurringThresholdUsd != null,
            recurringWagerUsd: value.recurringThresholdUsd,
            windowDays: VIP_PERKS_WINDOW_DAYS,
            updatedAt: null,
          },
          wagers: {
            link_id: row.link_id,
            initial_wager_usd: String(value.initialWagerUsd),
            has_active_creator_code: value.initialCreatorCodeApplied,
            previous_cycle_wager_usd: String(value.previousCycleWagerUsd),
            current_cycle_wager_usd: String(value.currentCycleWagerUsd),
          },
          now,
        });
        Object.assign(byUser.get(row.user_id)!, value);
      }
      const changed = locked.last_status !== value.status || locked.last_active !== value.active;
      await tx.execute(sql`
        UPDATE vip_perk_entitlements
        SET last_status = ${value.status}, last_active = ${value.active},
          last_initial_wager_usd = ${String(value.initialWagerUsd)},
          last_previous_cycle_wager_usd = ${String(value.previousCycleWagerUsd)},
          last_current_cycle_wager_usd = ${String(value.currentCycleWagerUsd)},
          last_evaluated_at = ${now}, updated_at = NOW()
        WHERE link_id = ${row.link_id}::uuid
      `);
      if (changed || shouldUnlock) {
        await tx.execute(sql`
          INSERT INTO admin_audit_events (event_type, target_user_id, metadata)
          VALUES (
            'vip_perks_entitlement_changed', ${row.user_id},
            ${JSON.stringify({
              fromStatus: locked.last_status,
              fromActive: locked.last_active,
              toStatus: value.status,
              toActive: value.active,
              initialUnlocked: shouldUnlock,
              initialThresholdUsd: value.initialThresholdUsd,
              initialCreatorCodeApplied: value.initialCreatorCodeApplied,
              linkId: row.link_id,
              source: "evaluation",
            })}::jsonb
          )
        `);
      }
    }
  });
}

async function evaluateRows(
  rows: EntitlementRow[],
  persist: boolean,
): Promise<VipPerksEntitlement[]> {
  if (rows.length === 0) return [];
  const settings = await getVipPerksSettings();
  const now = new Date();
  const wagers = await wagerByWindow(rows, settings, now);
  const values = rows.map((row) =>
    toEntitlement({ row, settings, wagers: wagers.get(row.link_id), now }),
  );
  if (persist) await persistEvaluations(rows, values, now);
  return values;
}

export async function getVipPerksForUsers(
  userIds: string[],
): Promise<Map<string, VipPerksEntitlement>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length > MAX_BATCH_SIZE) {
    throw new VipPerksError(400, "too_many_users", `At most ${MAX_BATCH_SIZE} users can be evaluated at once.`);
  }
  // Admin page reads must stay render-pure. Durable transitions are committed
  // by the bot sync and payout-bearing `isVipPerksActive` check below.
  const values = await evaluateRows(
    await loadEntitlementRows({ userIds: unique }),
    false,
  );
  return new Map(values.map((value) => [value.userId, value]));
}

/**
 * Evaluates the entitlement owned by one Discord member in their exact linked
 * VIP channel. The caller never supplies or learns the internal Packy user id.
 *
 * Unlike the Admin roster read, this persists transitions: `/perks` is an
 * explicit member check, so meeting the initial requirement should unlock the
 * backend entitlement immediately instead of waiting for the next role-sync
 * poll. Reload after a first unlock so the response includes the newly anchored
 * recurring cycle rather than the pre-transition null dates.
 */
export async function getVipPerksStatusForDiscordMember(input: {
  guildId: string;
  channelId: string;
  discordUserId: string;
}): Promise<VipPerksEntitlement> {
  const link = await adminDrizzle.execute<{ user_id: string }>(sql`
    SELECT user_id
    FROM discord_vip_channel_links
    WHERE guild_id = ${input.guildId}
      AND channel_id = ${input.channelId}
      AND member_discord_user_id = ${input.discordUserId}
    LIMIT 1
  `);
  const userId = link.rows[0]?.user_id;
  if (!userId) {
    throw new VipPerksError(
      404,
      "vip_channel_not_linked",
      "Run this command as the linked VIP member in your linked VIP channel.",
    );
  }

  const before = await loadEntitlementRows({ userIds: [userId] });
  const [value] = await evaluateRows(before, true);
  if (!value) {
    throw new VipPerksError(404, "vip_link_not_found", "That VIP link has no perk entitlement.");
  }
  if (value.active && value.initialUnlockedAt === null) {
    const [refreshed] = await evaluateRows(
      await loadEntitlementRows({ userIds: [userId] }),
      false,
    );
    if (refreshed) return refreshed;
  }
  return value;
}

export async function isVipPerksActive(userId: string): Promise<boolean> {
  try {
    const values = await evaluateRows(
      await loadEntitlementRows({ userIds: [userId] }),
      true,
    );
    return values[0]?.active === true;
  } catch (error) {
    console.error("[vip-perks] Fail-closed entitlement check failed:", error);
    return false;
  }
}

export async function getVipPerksSyncPage(input: {
  afterLinkId?: string;
  limit?: number;
}): Promise<{ members: VipPerksEntitlement[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(MAX_BATCH_SIZE, input.limit ?? 100));
  const rows = await loadEntitlementRows({ afterLinkId: input.afterLinkId, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    members: await evaluateRows(page, true),
    nextCursor: hasMore ? page.at(-1)?.link_id ?? null : null,
  };
}

export async function resetVipPerksQualification(input: {
  userId: string;
  actorAdminId: string;
  idempotencyKey: string;
}): Promise<VipPerksEntitlement> {
  const now = new Date();
  await adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`vip-perks-reset:${input.idempotencyKey}`}, 0))`);
    const existing = await tx.execute<{
      link_id: string;
      user_id: string;
      actor_admin_id: string | null;
    }>(sql`
      SELECT o.link_id, l.user_id, o.actor_admin_id::text AS actor_admin_id
      FROM vip_perk_reset_operations o
      JOIN discord_vip_channel_links l ON l.id = o.link_id
      WHERE o.idempotency_key = ${input.idempotencyKey}::uuid
    `);
    if (existing.rows[0]) {
      if (
        existing.rows[0].user_id !== input.userId
        || existing.rows[0].actor_admin_id !== input.actorAdminId
      ) {
        throw new VipPerksError(409, "idempotency_conflict", "That reset idempotency key is already bound to another request.");
      }
      return;
    }
    const link = await tx.execute<{ id: string }>(sql`
      SELECT id FROM discord_vip_channel_links
      WHERE guild_id = ${VIPS_GUILD_ID} AND user_id = ${input.userId}
      FOR UPDATE
    `);
    const linkId = link.rows[0]?.id;
    if (!linkId) throw new VipPerksError(404, "vip_link_not_found", "That user has no VIP channel link.");
    await tx.execute(sql`
      INSERT INTO vip_perk_entitlements (link_id, initial_window_started_at)
      VALUES (${linkId}::uuid, ${now})
      ON CONFLICT (link_id) DO UPDATE SET
        initial_window_started_at = EXCLUDED.initial_window_started_at,
        initial_unlocked_at = NULL,
        initial_threshold_usd = NULL,
        initial_had_creator_code = NULL,
        last_status = 'pending',
        last_active = false,
        last_initial_wager_usd = 0,
        last_previous_cycle_wager_usd = 0,
        last_current_cycle_wager_usd = 0,
        last_evaluated_at = NULL,
        updated_at = NOW()
    `);
    await tx.execute(sql`
      INSERT INTO vip_perk_reset_operations (
        idempotency_key, link_id, actor_admin_id, window_started_at
      ) VALUES (
        ${input.idempotencyKey}::uuid, ${linkId}::uuid,
        ${input.actorAdminId}::uuid, ${now}
      )
    `);
    await tx.execute(sql`
      INSERT INTO admin_audit_events (
        admin_user_id, event_type, target_user_id, metadata
      ) VALUES (
        ${input.actorAdminId}::uuid, 'vip_perks_qualification_reset',
        ${input.userId},
        ${JSON.stringify({ idempotencyKey: input.idempotencyKey, windowStartedAt: now.toISOString() })}::jsonb
      )
    `);
  });
  const result = await getVipPerksForUsers([input.userId]);
  const value = result.get(input.userId);
  if (!value) throw new VipPerksError(404, "vip_link_not_found", "That user has no VIP channel link.");
  return value;
}

export { VIP_PERKS_WINDOW_DAYS, VIP_PERKS_WINDOW_MS };
