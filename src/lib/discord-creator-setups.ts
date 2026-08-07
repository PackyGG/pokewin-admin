import "server-only";

import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_audit_events,
  admin_leaderboard_sponsorship,
  creator_reward_programs,
  discord_creator_setups,
} from "@/lib/db-schema/admin/schema";
import { affiliate_codes, user } from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { postgresTimestamp } from "@/lib/postgres-runtime";
import { toNumber } from "@/lib/utils/decimal";
import { creatorsApi, type CreatorDealResponse } from "@/lib/backend-api";
import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { getAffiliateLeaderboardPage } from "@/lib/queries/creators-leaderboards";
import { isDiscordBotSuperuser } from "@/lib/discord-bot-superusers";
import { isDiscordDashboardOperator } from "@/lib/discord-dashboard-operators";
import { calculateWindowedPnl } from "@/lib/queries/pnl";

export const CREATOR_SETUP_GUILD_ID = "1402743122789929022";

type SetupRow = {
  id: string;
  guild_id: string;
  creator_discord_user_id: string;
  created_by_discord_user_id: string;
  interaction_id: string;
  status: "pending" | "active";
  category_id: string | null;
  chat_channel_id: string | null;
  logs_channel_id: string | null;
  category_name: string | null;
  creator_user_id: string | null;
  linked_by_discord_user_id: string | null;
  link_interaction_id: string | null;
};

export type CreatorSetup = {
  guildId: string;
  creatorDiscordUserId: string;
  categoryId: string;
  chatChannelId: string;
  logsChannelId: string;
  categoryName: string;
  creatorUserId: string | null;
};

export type CreatorSetupStats = {
  periodDays: 7 | 14 | 30 | null;
  generatedAt: string;
  creator: {
    userId: string;
    username: string | null;
    codes: string[];
  };
  totals: CreatorCodeStats;
  byCode: CreatorCodeStats[];
};

export type CreatorSetupUserStats = {
  generatedAt: string;
  player: {
    username: string;
    code: string;
    periodStartedAt: string;
    periodExpiresAt: string;
  };
  totals: {
    leaderboardWagerUsd: number;
    depositsUsd: number;
    earningsUsd: number;
    /** Player perspective: positive means the player won, negative means they lost. */
    pnlUsd: number;
  };
};

export type CreatorCodeStats = {
  code: string | null;
  clicks: number;
  signups: number;
  firstTimeDepositors: number;
  activePlayers: number;
  depositsUsd: number;
  wagerUsd: number;
  earningsUsd: number;
};

export type CreatorSetupDeal = {
  generatedAt: string;
  creator: {
    userId: string;
    username: string | null;
  };
  deal: {
    status: "scheduled" | "active";
    weekStartUtc: string;
    weekEndUtc: string;
    fillsAllowed: number;
    fillsUsed: number;
    perFillUsd: number;
    conversionRatePercent: number;
    withdrawalCapUsd: number | null;
    withdrawalCapUsedUsd: number;
    cooldownMinutes: number;
    maxTipPerStreamUsd: number;
    maxTipPerUserUsd: number;
    maxSponsoredBattleUsd: number;
    maxSponsorshipPerStreamUsd: number;
    allowSiteLeaderboards: boolean;
    allowCodeLeaderboards: boolean;
    leaderboardPrizePoolUsd: number | null;
    leaderboardPackySharePercent: number | null;
  } | null;
};

export type CreatorSetupLeaderboard = {
  generatedAt: string;
  totalPrizeUsd: number;
  totalEntries: number;
  page: number;
  pageSize: 10;
  entries: Array<{
    rank: number;
    username: string;
    wagerUsd: number;
    prizeUsd: number | null;
  }>;
};

export class CreatorSetupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CreatorSetupError";
  }
}

function activeSetup(row: SetupRow): CreatorSetup {
  if (
    row.status !== "active" ||
    !row.category_id ||
    !row.chat_channel_id ||
    !row.logs_channel_id ||
    !row.category_name
  ) {
    throw new Error("Active creator setup has incomplete channel data");
  }

  return {
    guildId: row.guild_id,
    creatorDiscordUserId: row.creator_discord_user_id,
    categoryId: row.category_id,
    chatChannelId: row.chat_channel_id,
    logsChannelId: row.logs_channel_id,
    categoryName: row.category_name,
    creatorUserId: row.creator_user_id ?? null,
  };
}

async function findPackyUser(
  creatorUserId: string,
): Promise<{
  id: string;
  username: string | null;
  role: string;
  roles: string[];
} | null> {
  const db = getProdReadDrizzleDb();
  const [creator] = await db
    .select({
      id: user.id,
      username: user.username,
      role: user.role,
      roles: user.roles,
    })
    .from(user)
    .where(eq(user.id, creatorUserId))
    .limit(1);

  return creator ? { ...creator, roles: creator.roles ?? [] } : null;
}

async function requireActiveCreator(
  creatorUserId: string,
): Promise<{ id: string; username: string | null }> {
  const creator = await findPackyUser(creatorUserId);

  if (
    !creator ||
    (creator.role !== "creator" && !creator.roles.includes("creator"))
  ) {
    throw new CreatorSetupError(
      404,
      "creator_not_found",
      "That Packy user does not have the active creator role.",
    );
  }
  return { id: creator.id, username: creator.username };
}

async function ensureActiveCreator(
  creatorUserId: string,
  allowGrant: boolean,
): Promise<{ roleGranted: boolean }> {
  const creator = await findPackyUser(creatorUserId);
  if (!creator) {
    throw new CreatorSetupError(
      404,
      "creator_not_found",
      "That Packy user does not exist.",
    );
  }
  if (
    creator.role === "creator" ||
    creator.roles.includes("creator")
  ) {
    return { roleGranted: false };
  }
  if (!allowGrant) {
    throw new CreatorSetupError(
      404,
      "creator_not_found",
      "That Packy user does not have the active creator role.",
    );
  }

  const promoted = await creatorsApi.promote(creatorUserId);
  if (
    promoted.user_id !== creatorUserId ||
    promoted.role !== "creator"
  ) {
    throw new CreatorSetupError(
      502,
      "creator_promotion_failed",
      "The creator role update returned an unexpected result.",
    );
  }
  return { roleGranted: !promoted.already_creator };
}

type UsageStatsRow = {
  code: string | null;
  signups: string;
  first_time_depositors: string;
  active_players: string;
  wager_usd: string;
  earnings_usd: string;
};

export type CreatorSetupRewards = {
  generatedAt: string;
  creator: {
    userId: string;
    username: string | null;
  };
  programs: Array<{
    name: string;
    codes: string[];
    wager: {
      thresholdUsd: number;
      rewardUsd: number;
      vipRewardUsd: number | null;
    } | null;
    lossback: {
      percent: number;
      minDepositUsd: number;
    } | null;
    maxRewardPerUserUsd: number | null;
    accrualStartAt: string;
    /** ISO-8601 UTC scheduled stop; null means no scheduled end. */
    endsAt: string | null;
  }>;
};

type DepositStatsRow = {
  code: string | null;
  deposits_usd: string;
};

type ClickStatsRow = {
  code: string | null;
  clicks: string;
};

const money = (value: unknown): number =>
  Math.round(toNumber(value) * 100) / 100;

function emptyCodeStats(code: string | null): CreatorCodeStats {
  return {
    code,
    clicks: 0,
    signups: 0,
    firstTimeDepositors: 0,
    activePlayers: 0,
    depositsUsd: 0,
    wagerUsd: 0,
    earningsUsd: 0,
  };
}

function readCodeStats(
  code: string | null,
  usage: UsageStatsRow | undefined,
  deposits: DepositStatsRow | undefined,
  clicks: ClickStatsRow | undefined,
): CreatorCodeStats {
  return {
    code,
    clicks: Number(clicks?.clicks ?? 0),
    signups: Number(usage?.signups ?? 0),
    firstTimeDepositors: Number(usage?.first_time_depositors ?? 0),
    activePlayers: Number(usage?.active_players ?? 0),
    depositsUsd: money(deposits?.deposits_usd ?? 0),
    wagerUsd: money(usage?.wager_usd ?? 0),
    earningsUsd: money(usage?.earnings_usd ?? 0),
  };
}

export async function requireLinkedSetupActor(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
}, options: {
  allowDashboardOperator?: boolean;
} = {}): Promise<SetupRow & { creator_user_id: string }> {
  const setupResult = await adminDrizzle.execute<SetupRow>(sql`
    SELECT
      id,
      guild_id,
      creator_discord_user_id,
      created_by_discord_user_id,
      interaction_id,
      status,
      category_id,
      chat_channel_id,
      logs_channel_id,
      category_name,
      creator_user_id,
      linked_by_discord_user_id,
      link_interaction_id
    FROM discord_creator_setups
    WHERE guild_id = ${input.guildId}
      AND category_id = ${input.categoryId}
      AND (
        chat_channel_id = ${input.channelId}
        OR logs_channel_id = ${input.channelId}
      )
      AND status = 'active'
    LIMIT 1
  `);
  const setup = setupResult.rows[0];
  if (!setup) {
    throw new CreatorSetupError(
      404,
      "setup_not_found",
      "This channel does not belong to an active creator section.",
    );
  }
  const isPrivilegedActor =
    isDiscordBotSuperuser(input.actorDiscordUserId) ||
    (options.allowDashboardOperator === true &&
      isDiscordDashboardOperator(input.actorDiscordUserId));
  if (
    !isPrivilegedActor &&
    input.actorDiscordUserId !== setup.creator_discord_user_id &&
    input.actorDiscordUserId !== setup.created_by_discord_user_id
  ) {
    throw new CreatorSetupError(
      403,
      "setup_actor_forbidden",
      "Only this creator or the staff member who created the section can view its data.",
    );
  }
  if (!setup.creator_user_id) {
    throw new CreatorSetupError(
      409,
      "setup_not_linked",
      "This creator section is not linked to a Packy account yet.",
    );
  }
  return setup as SetupRow & { creator_user_id: string };
}

export async function getCreatorDashboardContext(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
}): Promise<{ userId: string }> {
  if (!isDiscordDashboardOperator(input.actorDiscordUserId)) {
    throw new CreatorSetupError(
      403,
      "setup_actor_forbidden",
      "Only an authorized dashboard operator can open creator accounts.",
    );
  }

  const setupResult = await adminDrizzle.execute<{ creator_user_id: string | null }>(sql`
    SELECT creator_user_id
    FROM discord_creator_setups
    WHERE guild_id = ${input.guildId}
      AND category_id = ${input.categoryId}
      AND (
        chat_channel_id = ${input.channelId}
        OR logs_channel_id = ${input.channelId}
      )
      AND status = 'active'
    LIMIT 1
  `);
  const setup = setupResult.rows[0];
  if (!setup) {
    throw new CreatorSetupError(
      404,
      "setup_not_found",
      "This channel does not belong to an active creator section.",
    );
  }
  if (!setup.creator_user_id) {
    throw new CreatorSetupError(
      409,
      "setup_not_linked",
      "This creator section is not linked to a Packy account yet.",
    );
  }
  return { userId: setup.creator_user_id };
}

export async function getCreatorSetupStats(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
  periodDays: 7 | 14 | 30 | null;
}): Promise<CreatorSetupStats> {
  const setup = await requireLinkedSetupActor(input);

  const db = getProdReadDrizzleDb();
  const [creator, ownedCodes, excludedUserIds] = await Promise.all([
    requireActiveCreator(setup.creator_user_id),
    db
      .select({ code: affiliate_codes.code })
      .from(affiliate_codes)
      .where(eq(affiliate_codes.user_id, setup.creator_user_id))
      .orderBy(affiliate_codes.created_at),
    getExcludedUserIds(),
  ]);
  const codes = Array.from(
    new Set(
      ownedCodes
        .map((row) => row.code.trim().toUpperCase())
        .filter(Boolean),
    ),
  );

  if (codes.length === 0) {
    return {
      periodDays: input.periodDays,
      generatedAt: new Date().toISOString(),
      creator: { userId: creator.id, username: creator.username, codes },
      totals: emptyCodeStats(null),
      byCode: [],
    };
  }

  const excludedFilter =
    excludedUserIds.length > 0
      ? sql`AND acu.referred_user_id <> ALL(${pgArrayParam(excludedUserIds)}::text[])`
      : sql``;
  const excludedDepositFilter =
    excludedUserIds.length > 0
      ? sql`AND lt.user_id <> ALL(${pgArrayParam(excludedUserIds)}::text[])`
      : sql``;
  const usageWindow = input.periodDays === null
    ? sql``
    : sql`AND acu.created_at >= NOW() - (${input.periodDays} * INTERVAL '1 day')`;
  const depositWindow = input.periodDays === null
    ? sql``
    : sql`AND lt.created_at >= NOW() - (${input.periodDays} * INTERVAL '1 day')`;
  const clickWindow = input.periodDays === null
    ? sql``
    : sql`AND created_at >= NOW() - (${input.periodDays} * INTERVAL '1 day')`;
  const [usageResult, depositResult, clickResult] = await Promise.all([
    db.execute<UsageStatsRow>(sql`
      SELECT
        CASE
          WHEN GROUPING(UPPER(acu.code)) = 1 THEN NULL
          ELSE UPPER(acu.code)
        END AS code,
        COUNT(DISTINCT acu.referred_user_id)::text AS signups,
        COUNT(DISTINCT acu.referred_user_id) FILTER (
          WHERE acu.usage_type::text = 'deposit'
        )::text AS first_time_depositors,
        COUNT(DISTINCT acu.referred_user_id) FILTER (
          WHERE acu.usage_type::text IN ('deposit', 'wager')
        )::text AS active_players,
        COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS wager_usd,
        COALESCE(SUM(acu.referrer_cut_usd::numeric), 0)::text AS earnings_usd
      FROM affiliate_code_usages acu
      JOIN "user" referred ON referred.id = acu.referred_user_id
      WHERE acu.affiliate_user_id = ${setup.creator_user_id}
        AND UPPER(acu.code) = ANY(${pgArrayParam(codes)}::text[])
        AND acu.status::text = 'completed'
        AND acu.referred_user_id <> acu.affiliate_user_id
        ${usageWindow}
        AND referred.role::text NOT IN ('admin', 'support', 'creator')
        ${excludedFilter}
      GROUP BY GROUPING SETS ((UPPER(acu.code)), ())
    `),
    db.execute<DepositStatsRow>(sql`
      WITH covered_deposits AS (
        SELECT DISTINCT ON (lt.id)
          lt.id,
          UPPER(acu.code) AS code,
          lt.amount::numeric AS amount_usd
        FROM ledger_transactions lt
        JOIN "user" referred ON referred.id = lt.user_id
        JOIN affiliate_code_usages acu
          ON acu.referred_user_id = lt.user_id
          AND acu.affiliate_user_id = ${setup.creator_user_id}
          AND UPPER(acu.code) = ANY(${pgArrayParam(codes)}::text[])
          AND acu.status::text = 'completed'
          AND acu.created_at <= lt.created_at
          AND acu.created_at >= lt.created_at - INTERVAL '7 days'
          AND acu.referred_user_id <> acu.affiliate_user_id
        WHERE lt.type = 'deposit'
          AND lt.status = 'completed'
        ${depositWindow}
          AND referred.role::text NOT IN ('admin', 'support', 'creator')
          ${excludedDepositFilter}
        ORDER BY lt.id, acu.created_at DESC, acu.id DESC
      )
      SELECT
        CASE
          WHEN GROUPING(code) = 1 THEN NULL
          ELSE code
        END AS code,
        COALESCE(SUM(amount_usd), 0)::text AS deposits_usd
      FROM covered_deposits
      GROUP BY GROUPING SETS ((code), ())
    `),
    db.execute<ClickStatsRow>(sql`
      SELECT
        CASE
          WHEN GROUPING(UPPER(code)) = 1 THEN NULL
          ELSE UPPER(code)
        END AS code,
        COUNT(*)::text AS clicks
      FROM affiliate_clicks
      WHERE UPPER(code) = ANY(${pgArrayParam(codes)}::text[])
        ${clickWindow}
      GROUP BY GROUPING SETS ((UPPER(code)), ())
    `),
  ]);

  const usageByCode = new Map(
    usageResult.rows
      .filter((row) => row.code)
      .map((row) => [row.code!, row]),
  );
  const clicksByCode = new Map(
    clickResult.rows
      .filter((row) => row.code)
      .map((row) => [row.code!, row]),
  );
  const depositsByCode = new Map(
    depositResult.rows
      .filter((row) => row.code)
      .map((row) => [row.code!, row]),
  );
  const totalUsage = usageResult.rows.find((row) => row.code === null);
  const totalDeposits = depositResult.rows.find((row) => row.code === null);
  const totalClicks = clickResult.rows.find((row) => row.code === null);

  return {
    periodDays: input.periodDays,
    generatedAt: new Date().toISOString(),
    creator: {
      userId: creator.id,
      username: creator.username,
      codes,
    },
    totals: readCodeStats(null, totalUsage, totalDeposits, totalClicks),
    byCode: codes.map((code) =>
      readCodeStats(
        code,
        usageByCode.get(code),
        depositsByCode.get(code),
        clicksByCode.get(code),
      ),
    ),
  };
}

/** Poll-safe stream lifecycle snapshot for the Discord admin-log worker. */
export async function getCreatorSetupStreamEvents(input: { after: string }) {
  const parsed = new Date(input.after);
  const cutoff = Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : new Date(Date.now() - 10 * 60_000).toISOString();
  const setups = await adminDrizzle.select({
    guildId: discord_creator_setups.guild_id,
    categoryId: discord_creator_setups.category_id,
    creatorUserId: discord_creator_setups.creator_user_id,
  }).from(discord_creator_setups).where(and(
    eq(discord_creator_setups.status, "active"),
    sql`${discord_creator_setups.creator_user_id} IS NOT NULL`,
  ));
  const linked = setups.filter((row) => row.creatorUserId && row.categoryId);
  if (!linked.length) return { events: [], serverTime: new Date().toISOString() };
  const ids = linked.map((row) => row.creatorUserId!);
  const db = getProdReadDrizzleDb();
  const result = await db.execute(sql`
    SELECT id::text, user_id, deal_id::text, status::text, activated_at, first_bet_at,
      ended_at, converted_at, auto_end_at, fill_loaded_usd::text, fill_spent_usd::text,
      fill_refunded_usd::text, fill_remaining_usd::text, ending_balance_usd::text,
      conversion_rate_bps_snapshot, converted_to_raw_usd::text, version, updated_at
    FROM creator_stream_sessions
    WHERE user_id = ANY(${pgArrayParam(ids)}::text[])
      AND updated_at >= ${cutoff}::timestamptz
    ORDER BY updated_at ASC
    LIMIT 500
  `);
  const byCreator = new Map(linked.map((row) => [row.creatorUserId!, row]));
  return {
    serverTime: new Date().toISOString(),
    events: result.rows.map((row: any) => ({
      ...row,
      guildId: byCreator.get(row.user_id)?.guildId,
      categoryId: byCreator.get(row.user_id)?.categoryId,
    })).filter((row) => row.guildId && row.categoryId),
  };
}

/**
 * Returns one public-username player's activity only while their current,
 * unexpired code belongs to the creator bound to this Discord section.
 *
 * The username is the canonical `user.username` rendered by Packy's public
 * chat and creator leaderboards. Missing users, expired codes, and users on
 * another creator's code deliberately share one error so this lookup cannot
 * be used to enumerate unrelated accounts.
 */
export async function getCreatorSetupUserStats(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
  username: string;
}): Promise<CreatorSetupUserStats> {
  const setup = await requireLinkedSetupActor(input, {
    allowDashboardOperator: true,
  });
  await requireActiveCreator(setup.creator_user_id);

  const db = getProdReadDrizzleDb();
  const excludedUserIds = await getExcludedUserIds();
  const excludedFilter =
    excludedUserIds.length > 0
      ? sql`AND target.id <> ALL(${pgArrayParam(excludedUserIds)}::text[])`
      : sql``;
  const targetResult = await db.execute<{
    id: string;
    username: string;
    code: string;
    period_started_at: Date | string;
    period_expires_at: Date | string;
    leaderboard_wager_usd: string;
    deposits_usd: string;
    earnings_usd: string;
  }>(sql`
    WITH target AS (
      SELECT
        candidate.id,
        candidate.username,
        UPPER(candidate.affiliate_code) AS code,
        candidate.affiliate_code_expires_at - INTERVAL '7 days' AS period_started_at,
        candidate.affiliate_code_expires_at AS period_expires_at
      FROM "user" candidate
      WHERE LOWER(candidate.username) = LOWER(${input.username})
        AND candidate.role::text NOT IN ('admin', 'support', 'creator')
        AND candidate.affiliate_code_active = true
        AND candidate.affiliate_code IS NOT NULL
        AND candidate.affiliate_code_expires_at > NOW()
        AND EXISTS (
          SELECT 1
          FROM affiliate_codes owned
          WHERE owned.user_id = ${setup.creator_user_id}
            AND UPPER(owned.code) = UPPER(candidate.affiliate_code)
        )
      LIMIT 1
    ), usage AS (
      SELECT
        COALESCE(SUM(
          COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric
        ) FILTER (WHERE acu.usage_type::text = 'wager'), 0)::text AS leaderboard_wager_usd,
        COALESCE(SUM(acu.referrer_cut_usd::numeric), 0)::text AS earnings_usd
      FROM target
      LEFT JOIN affiliate_code_usages acu
        ON acu.referred_user_id = target.id
        AND acu.affiliate_user_id = ${setup.creator_user_id}
        AND UPPER(acu.code) = target.code
        AND acu.status::text = 'completed'
        AND acu.created_at >= target.period_started_at
        AND acu.created_at <= NOW()
    ), deposits AS (
      SELECT COALESCE(SUM(lt.amount::numeric), 0)::text AS deposits_usd
      FROM target
      LEFT JOIN ledger_transactions lt
        ON lt.user_id = target.id
        AND lt.type = 'deposit'
        AND lt.status = 'completed'
        AND lt.created_at >= target.period_started_at
        AND lt.created_at <= NOW()
    )
    SELECT
      target.*,
      usage.leaderboard_wager_usd,
      deposits.deposits_usd,
      usage.earnings_usd
    FROM target
    CROSS JOIN usage
    CROSS JOIN deposits
    WHERE true
      ${excludedFilter}
    LIMIT 1
  `);
  const target = targetResult.rows[0];
  if (!target) {
    throw new CreatorSetupError(
      404,
      "creator_user_not_active",
      "No active user with that username is currently using this creator's code.",
    );
  }

  const periodStartedAt = postgresTimestamp(
    target.period_started_at,
    "creatorUserStats.period_started_at",
  );
  const periodExpiresAt = postgresTimestamp(
    target.period_expires_at,
    "creatorUserStats.period_expires_at",
  );
  const windowedPnl = await calculateWindowedPnl({
    since: periodStartedAt,
    userId: target.id,
  });

  // The PnL calculation spans several canonical balance/inventory sources.
  // Recheck ownership after it completes so a concurrent code switch cannot
  // return stats after this creator's access has ended.
  const activeRecheck = await db.execute<{ active: boolean }>(sql`
    SELECT true AS active
    FROM "user" candidate
    WHERE candidate.id = ${target.id}
      AND candidate.affiliate_code_active = true
      AND candidate.affiliate_code_expires_at > NOW()
      AND UPPER(candidate.affiliate_code) = ${target.code}
      AND EXISTS (
        SELECT 1
        FROM affiliate_codes owned
        WHERE owned.user_id = ${setup.creator_user_id}
          AND UPPER(owned.code) = ${target.code}
      )
    LIMIT 1
  `);
  if (!activeRecheck.rows[0]) {
    throw new CreatorSetupError(
      404,
      "creator_user_not_active",
      "No active user with that username is currently using this creator's code.",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    player: {
      username: target.username,
      code: target.code,
      periodStartedAt: periodStartedAt.toISOString(),
      periodExpiresAt: periodExpiresAt.toISOString(),
    },
    totals: {
      leaderboardWagerUsd: money(target.leaderboard_wager_usd ?? 0),
      depositsUsd: money(target.deposits_usd ?? 0),
      earningsUsd: money(target.earnings_usd ?? 0),
      pnlUsd: money(-windowedPnl.pnl),
    },
  };
}

type CreatorLeaderboardTerms = Pick<
  NonNullable<CreatorSetupDeal["deal"]>,
  "leaderboardPrizePoolUsd" | "leaderboardPackySharePercent"
>;

async function getCurrentCreatorLeaderboard(
  creatorUserId: string,
): Promise<LeaderboardAdminRow | null> {
  const { leaderboards } = await affiliateLeaderboardsApi.list({
    status: "approved",
    creator_user_id: creatorUserId,
    limit: 50,
    offset: 0,
  });
  const liveLeaderboards = leaderboards.filter(
    (leaderboard) => leaderboard.time_status !== "ended",
  );
  return (
    liveLeaderboards.find(
      (leaderboard) => leaderboard.time_status === "active",
    ) ??
    liveLeaderboards
      .filter((leaderboard) => leaderboard.time_status === "upcoming")
      .sort((a, b) => a.start_date.localeCompare(b.start_date))[0] ??
    null
  );
}

async function getCreatorLeaderboardTerms(
  creatorUserId: string,
): Promise<CreatorLeaderboardTerms> {
  const leaderboard = await getCurrentCreatorLeaderboard(creatorUserId);

  if (!leaderboard) {
    return {
      leaderboardPrizePoolUsd: null,
      leaderboardPackySharePercent: null,
    };
  }

  const [sponsorship] = await adminDrizzle
    .select({
      sponsoredPercentage:
        admin_leaderboard_sponsorship.sponsored_percentage,
    })
    .from(admin_leaderboard_sponsorship)
    .where(
      eq(
        admin_leaderboard_sponsorship.leaderboard_id,
        leaderboard.id,
      ),
    )
    .limit(1);

  const prizePoolNumber = toNumber(leaderboard.total_prize_usd);
  const packySharePercent = sponsorship
    ? toNumber(sponsorship.sponsoredPercentage)
    : 100;
  return {
    leaderboardPrizePoolUsd:
      Number.isFinite(prizePoolNumber) && prizePoolNumber >= 0
        ? money(prizePoolNumber)
        : null,
    leaderboardPackySharePercent:
      Number.isFinite(packySharePercent) &&
      packySharePercent >= 0 &&
      packySharePercent <= 100
        ? Math.round(packySharePercent * 100) / 100
        : null,
  };
}

export async function getCreatorSetupLeaderboard(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
  page: number;
  pageSize: 10;
}): Promise<CreatorSetupLeaderboard> {
  const setup = await requireLinkedSetupActor(input);
  await requireActiveCreator(setup.creator_user_id);
  const leaderboard = await getCurrentCreatorLeaderboard(setup.creator_user_id);
  if (!leaderboard) {
    if (input.page > 0) {
      throw new CreatorSetupError(
        400,
        "invalid_request",
        "That leaderboard page no longer exists.",
      );
    }
    return {
      generatedAt: new Date().toISOString(),
      totalPrizeUsd: 0,
      totalEntries: 0,
      page: 0,
      pageSize: 10,
      entries: [],
    };
  }

  const standings = await getAffiliateLeaderboardPage({
    leaderboardId: leaderboard.id,
    creatorUserId: leaderboard.creator_user_id,
    coCreatorUserIds: leaderboard.co_creator_user_ids,
    affiliateCodes: leaderboard.affiliate_codes,
    startDate: new Date(leaderboard.start_date),
    endDate: new Date(leaderboard.end_date),
    prizeTiers: leaderboard.prize_tiers,
    page: input.page,
    pageSize: input.pageSize,
  });
  const totalPages = Math.max(1, Math.ceil(standings.totalEntries / input.pageSize));
  if (input.page >= totalPages) {
    throw new CreatorSetupError(
      400,
      "invalid_request",
      "That leaderboard page no longer exists.",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    totalPrizeUsd: money(leaderboard.total_prize_usd),
    totalEntries: standings.totalEntries,
    page: input.page,
    pageSize: 10,
    entries: standings.entries.map((entry) => ({
      rank: entry.position,
      username: entry.username?.trim() || "Anonymous player",
      wagerUsd: money(entry.totalWageredUsd),
      prizeUsd: entry.prizeUsd === null ? null : money(entry.prizeUsd),
    })),
  };
}

function creatorFacingDeal(
  deal: CreatorDealResponse,
  leaderboard: CreatorLeaderboardTerms,
): NonNullable<CreatorSetupDeal["deal"]> {
  return {
    status: deal.status === "scheduled" ? "scheduled" : "active",
    weekStartUtc: deal.week_start_utc,
    weekEndUtc: deal.week_end_utc,
    fillsAllowed: Math.max(0, deal.fills_allowed),
    fillsUsed: Math.max(0, deal.fills_used),
    perFillUsd: money(deal.per_fill_amount_usd),
    conversionRatePercent: Math.round(deal.conversion_rate_bps) / 100,
    withdrawalCapUsd:
      deal.total_withdraw_cap_usd === null
        ? null
        : money(deal.total_withdraw_cap_usd),
    withdrawalCapUsedUsd: money(deal.withdraw_cap_used_usd),
    cooldownMinutes: Math.max(0, deal.cooldown_minutes),
    maxTipPerStreamUsd: money(deal.max_tip_per_stream_usd),
    maxTipPerUserUsd: money(deal.max_tip_per_user_usd),
    maxSponsoredBattleUsd: money(deal.max_sponsored_battle_usd),
    maxSponsorshipPerStreamUsd: money(
      deal.max_sponsorship_per_stream_usd,
    ),
    allowSiteLeaderboards: deal.allow_site_leaderboards,
    allowCodeLeaderboards: deal.allow_code_leaderboards,
    ...leaderboard,
  };
}

export async function getCreatorSetupDeal(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
}): Promise<CreatorSetupDeal> {
  const setup = await requireLinkedSetupActor(input);
  const creator = await requireActiveCreator(setup.creator_user_id);
  const deals = await creatorsApi.listDeals(setup.creator_user_id, {
    limit: 50,
    offset: 0,
  });
  const current =
    deals.data.find((deal) => deal.status === "active") ??
    deals.data
      .filter((deal) => deal.status === "scheduled")
      .sort((a, b) => a.week_start_utc.localeCompare(b.week_start_utc))[0] ??
    null;
  const leaderboard = current
    ? await getCreatorLeaderboardTerms(setup.creator_user_id)
    : null;

  return {
    generatedAt: new Date().toISOString(),
    creator: { userId: creator.id, username: creator.username },
    deal: current && leaderboard ? creatorFacingDeal(current, leaderboard) : null,
  };
}

export async function getCreatorSetupRewards(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
}): Promise<CreatorSetupRewards> {
  const setup = await requireLinkedSetupActor(input);
  const creator = await requireActiveCreator(setup.creator_user_id);
  const programs = await adminDrizzle
    .select({
      name: creator_reward_programs.name,
      codes: creator_reward_programs.codes,
      thresholdUsd: creator_reward_programs.threshold_usd,
      rewardUsd: creator_reward_programs.reward_usd,
      vipRewardUsd: creator_reward_programs.vip_reward_usd,
      lossbackPct: creator_reward_programs.lossback_pct,
      minDepositUsd: creator_reward_programs.min_deposit_usd,
      maxRewardPerUserUsd: creator_reward_programs.max_reward_per_user_usd,
      accrualStartAt: creator_reward_programs.accrual_start_at,
      endsAt: creator_reward_programs.ends_at,
    })
    .from(creator_reward_programs)
    .where(
      and(
        eq(creator_reward_programs.creator_user_id, setup.creator_user_id),
        eq(creator_reward_programs.is_active, true),
        or(
          isNull(creator_reward_programs.ends_at),
          gt(creator_reward_programs.ends_at, sql`now()`),
        ),
      ),
    )
    .orderBy(desc(creator_reward_programs.created_at));

  return {
    generatedAt: new Date().toISOString(),
    creator: { userId: creator.id, username: creator.username },
    programs: programs.map((program) => ({
      name: program.name,
      codes: [
        ...new Set(
          (program.codes ?? [])
            .map((code) => code.trim().toUpperCase())
            .filter(Boolean),
        ),
      ],
      wager:
        program.thresholdUsd !== null && program.rewardUsd !== null
          ? {
              thresholdUsd: money(program.thresholdUsd),
              rewardUsd: money(program.rewardUsd),
              vipRewardUsd:
                program.vipRewardUsd === null
                  ? null
                  : money(program.vipRewardUsd),
            }
          : null,
      lossback:
        program.lossbackPct !== null && program.minDepositUsd !== null
          ? {
              percent: money(program.lossbackPct),
              minDepositUsd: money(program.minDepositUsd),
            }
          : null,
      maxRewardPerUserUsd:
        program.maxRewardPerUserUsd === null
          ? null
          : money(program.maxRewardPerUserUsd),
      accrualStartAt: new Date(program.accrualStartAt).toISOString(),
      endsAt: program.endsAt ? new Date(program.endsAt).toISOString() : null,
    })),
  };
}

function linkedSetup(row: SetupRow): CreatorSetup {
  const setup = activeSetup(row);
  if (
    !row.creator_user_id ||
    !row.linked_by_discord_user_id ||
    !row.link_interaction_id
  ) {
    throw new Error("Linked creator setup has incomplete account data");
  }
  return setup;
}

export async function linkCreatorSetup(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  creatorUserId: string;
  actorDiscordUserId: string;
  interactionId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
}): Promise<{ status: "linked" | "already_linked"; setup: CreatorSetup }> {
  return adminDrizzle.transaction(async (tx) => {
    const actorIsSuperuser = isDiscordBotSuperuser(input.actorDiscordUserId);
    const auditRoleGrant = async (
      setupId: string,
      creatorDiscordUserId: string,
    ): Promise<void> => {
      await tx.insert(admin_audit_events).values({
        admin_user_id: null,
        event_type: "discord_creator_role_granted",
        target_user_id: input.creatorUserId,
        metadata: {
          apiKeyId: input.apiKeyId,
          apiKeyPrefix: input.apiKeyPrefix,
          setupId,
          guildId: input.guildId,
          creatorDiscordUserId,
          actorDiscordUserId: input.actorDiscordUserId,
          interactionId: input.interactionId,
          via: "backend_api",
        },
      });
    };

    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`discord-creator-link:${input.guildId}:${input.categoryId}`}, 0)
      )
    `);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`discord-creator-link-interaction:${input.interactionId}`}, 0)
      )
    `);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`discord-creator-link-account:${input.guildId}:${input.creatorUserId}`}, 0)
      )
    `);

    const interactionResult = await tx.execute<SetupRow>(sql`
      SELECT
        id,
        guild_id,
        creator_discord_user_id,
        created_by_discord_user_id,
        interaction_id,
        status,
        category_id,
        chat_channel_id,
        logs_channel_id,
        category_name,
        creator_user_id,
        linked_by_discord_user_id,
        link_interaction_id
      FROM discord_creator_setups
      WHERE link_interaction_id = ${input.interactionId}
      FOR UPDATE
    `);
    const interactionSetup = interactionResult.rows[0];
    if (interactionSetup) {
      if (
        interactionSetup.guild_id !== input.guildId ||
        interactionSetup.category_id !== input.categoryId ||
        (interactionSetup.chat_channel_id !== input.channelId &&
          interactionSetup.logs_channel_id !== input.channelId) ||
        interactionSetup.creator_user_id !== input.creatorUserId ||
        interactionSetup.linked_by_discord_user_id !== input.actorDiscordUserId
      ) {
        throw new CreatorSetupError(
          409,
          "idempotency_conflict",
          "That Discord interaction is already bound to another creator link.",
        );
      }
      const { roleGranted } = await ensureActiveCreator(
        input.creatorUserId,
        actorIsSuperuser,
      );
      if (roleGranted) {
        await auditRoleGrant(
          interactionSetup.id,
          interactionSetup.creator_discord_user_id,
        );
      }
      return {
        status: "already_linked" as const,
        setup: linkedSetup(interactionSetup),
      };
    }

    const setupResult = await tx.execute<SetupRow>(sql`
      SELECT
        id,
        guild_id,
        creator_discord_user_id,
        created_by_discord_user_id,
        interaction_id,
        status,
        category_id,
        chat_channel_id,
        logs_channel_id,
        category_name,
        creator_user_id,
        linked_by_discord_user_id,
        link_interaction_id
      FROM discord_creator_setups
      WHERE guild_id = ${input.guildId}
        AND category_id = ${input.categoryId}
        AND (
          chat_channel_id = ${input.channelId}
          OR logs_channel_id = ${input.channelId}
        )
        AND status = 'active'
      FOR UPDATE
    `);
    const setup = setupResult.rows[0];
    if (!setup) {
      throw new CreatorSetupError(
        404,
        "setup_not_found",
        "This channel does not belong to an active creator section.",
      );
    }
    if (
      !actorIsSuperuser &&
      input.actorDiscordUserId !== setup.creator_discord_user_id &&
      input.actorDiscordUserId !== setup.created_by_discord_user_id
    ) {
      throw new CreatorSetupError(
        403,
        "setup_actor_forbidden",
        "Only this creator or the staff member who created the section can link it.",
      );
    }

    if (setup.creator_user_id) {
      if (setup.creator_user_id !== input.creatorUserId) {
        throw new CreatorSetupError(
          409,
          "setup_link_conflict",
          "This creator section is already linked to another Packy account.",
        );
      }
      const { roleGranted } = await ensureActiveCreator(
        input.creatorUserId,
        actorIsSuperuser,
      );
      if (roleGranted) {
        await auditRoleGrant(setup.id, setup.creator_discord_user_id);
      }
      return {
        status: "already_linked" as const,
        setup: linkedSetup(setup),
      };
    }

    if (!actorIsSuperuser) {
      throw new CreatorSetupError(
        403,
        "setup_actor_forbidden",
        "Only authorized Packy staff can link a new Packy account to this section.",
      );
    }

    const conflictingResult = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM discord_creator_setups
      WHERE guild_id = ${input.guildId}
        AND creator_user_id = ${input.creatorUserId}
      FOR UPDATE
    `);
    if (conflictingResult.rows[0]) {
      throw new CreatorSetupError(
        409,
        "setup_link_conflict",
        "That Packy creator account is already linked to another section.",
      );
    }

    // `/link` owns only the creator-section mapping. The Discord member stored
    // by `/setup` is intentionally not read from or written to the Packy OAuth
    // account table. First-time binding is staff-only because no OAuth identity
    // proof is required by this workflow.
    const { roleGranted } = await ensureActiveCreator(input.creatorUserId, true);

    const updated = await tx.execute<SetupRow>(sql`
      UPDATE discord_creator_setups
      SET creator_user_id = ${input.creatorUserId},
          linked_by_discord_user_id = ${input.actorDiscordUserId},
          link_interaction_id = ${input.interactionId},
          deposit_notifications_enabled_at = CASE
            WHEN deposit_notifications_enabled = true
              THEN now()
            ELSE NULL
          END,
          signup_notifications_enabled_at = CASE
            WHEN signup_notifications_enabled = true
              THEN now()
            ELSE NULL
          END,
          linked_at = now()
      WHERE id = ${setup.id}::uuid
        AND creator_user_id IS NULL
      RETURNING
        id,
        guild_id,
        creator_discord_user_id,
        created_by_discord_user_id,
        interaction_id,
        status,
        category_id,
        chat_channel_id,
        logs_channel_id,
        category_name,
        creator_user_id,
        linked_by_discord_user_id,
        link_interaction_id
    `);
    const linked = updated.rows[0];
    if (!linked) {
      throw new CreatorSetupError(
        409,
        "setup_link_conflict",
        "This creator section was linked by another request.",
      );
    }

    if (roleGranted) {
      await auditRoleGrant(linked.id, linked.creator_discord_user_id);
    }

    await tx.insert(admin_audit_events).values({
      admin_user_id: null,
      event_type: "discord_creator_setup_linked",
      target_user_id: input.creatorUserId,
      metadata: {
        apiKeyId: input.apiKeyId,
        apiKeyPrefix: input.apiKeyPrefix,
        setupId: linked.id,
        guildId: input.guildId,
        categoryId: input.categoryId,
        channelId: input.channelId,
        creatorDiscordUserId: linked.creator_discord_user_id,
        actorDiscordUserId: input.actorDiscordUserId,
        interactionId: input.interactionId,
        creatorRoleGranted: roleGranted,
      },
    });

    return { status: "linked" as const, setup: linkedSetup(linked) };
  });
}

export async function prepareCreatorSetup(input: {
  guildId: string;
  creatorDiscordUserId: string;
  createdByDiscordUserId: string;
  interactionId: string;
}): Promise<
  | { status: "ready"; reservationId: string }
  | { status: "existing"; setup: CreatorSetup }
> {
  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`discord-creator-setup:${input.guildId}:${input.creatorDiscordUserId}`},
          0
        )
      )
    `);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`discord-creator-setup-interaction:${input.interactionId}`},
          0
        )
      )
    `);

    const interactionResult = await tx.execute<SetupRow>(sql`
      SELECT
        id,
        guild_id,
        creator_discord_user_id,
        interaction_id,
        status,
        category_id,
        chat_channel_id,
        logs_channel_id,
        category_name
      FROM discord_creator_setups
      WHERE interaction_id = ${input.interactionId}
      FOR UPDATE
    `);
    const interactionSetup = interactionResult.rows[0];
    if (interactionSetup) {
      if (
        interactionSetup.guild_id !== input.guildId ||
        interactionSetup.creator_discord_user_id !==
          input.creatorDiscordUserId
      ) {
        throw new CreatorSetupError(
          409,
          "setup_conflict",
          "That Discord interaction is already bound to another setup.",
        );
      }
      return interactionSetup.status === "active"
        ? { status: "existing" as const, setup: activeSetup(interactionSetup) }
        : { status: "ready" as const, reservationId: interactionSetup.id };
    }

    await tx.execute(sql`
      DELETE FROM discord_creator_setups
      WHERE guild_id = ${input.guildId}
        AND creator_discord_user_id = ${input.creatorDiscordUserId}
        AND status = 'pending'
        AND created_at < now() - INTERVAL '15 minutes'
    `);

    const existingResult = await tx.execute<SetupRow>(sql`
      SELECT
        id,
        guild_id,
        creator_discord_user_id,
        interaction_id,
        status,
        category_id,
        chat_channel_id,
        logs_channel_id,
        category_name
      FROM discord_creator_setups
      WHERE guild_id = ${input.guildId}
        AND creator_discord_user_id = ${input.creatorDiscordUserId}
      FOR UPDATE
    `);
    const existing = existingResult.rows[0];
    if (existing?.status === "active") {
      return { status: "existing" as const, setup: activeSetup(existing) };
    }
    if (existing) {
      throw new CreatorSetupError(
        409,
        "setup_in_progress",
        "That creator is already being set up.",
      );
    }

    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO discord_creator_setups (
        guild_id,
        creator_discord_user_id,
        created_by_discord_user_id,
        interaction_id,
        status
      )
      VALUES (
        ${input.guildId},
        ${input.creatorDiscordUserId},
        ${input.createdByDiscordUserId},
        ${input.interactionId},
        'pending'
      )
      RETURNING id
    `);

    return {
      status: "ready" as const,
      reservationId: inserted.rows[0]!.id,
    };
  });
}

export async function completeCreatorSetup(input: {
  reservationId: string;
  guildId: string;
  creatorDiscordUserId: string;
  categoryId: string;
  chatChannelId: string;
  logsChannelId: string;
  categoryName: string;
}): Promise<{ setup: CreatorSetup }> {
  return adminDrizzle.transaction(async (tx) => {
    const result = await tx.execute<SetupRow>(sql`
      SELECT
        id,
        guild_id,
        creator_discord_user_id,
        interaction_id,
        status,
        category_id,
        chat_channel_id,
        logs_channel_id,
        category_name
      FROM discord_creator_setups
      WHERE id = ${input.reservationId}::uuid
      FOR UPDATE
    `);
    const row = result.rows[0];
    if (!row) {
      throw new CreatorSetupError(
        404,
        "reservation_not_found",
        "That creator setup reservation no longer exists.",
      );
    }
    if (
      row.guild_id !== input.guildId ||
      row.creator_discord_user_id !== input.creatorDiscordUserId
    ) {
      throw new CreatorSetupError(
        409,
        "setup_conflict",
        "The reservation does not match this creator setup.",
      );
    }

    if (row.status === "active") {
      const setup = activeSetup(row);
      if (
        setup.categoryId !== input.categoryId ||
        setup.chatChannelId !== input.chatChannelId ||
        setup.logsChannelId !== input.logsChannelId ||
        setup.categoryName !== input.categoryName
      ) {
        throw new CreatorSetupError(
          409,
          "setup_conflict",
          "That reservation was completed with different Discord channels.",
        );
      }
      return { setup };
    }

    const completed = await tx.execute<SetupRow>(sql`
      UPDATE discord_creator_setups
      SET status = 'active',
          category_id = ${input.categoryId},
          chat_channel_id = ${input.chatChannelId},
          logs_channel_id = ${input.logsChannelId},
          category_name = ${input.categoryName},
          deposit_notifications_enabled_at = CASE
            WHEN deposit_notifications_enabled = true
              THEN COALESCE(deposit_notifications_enabled_at, now())
            ELSE NULL
          END,
          signup_notifications_enabled_at = CASE
            WHEN signup_notifications_enabled = true
              THEN COALESCE(signup_notifications_enabled_at, now())
            ELSE NULL
          END,
          completed_at = now()
      WHERE id = ${input.reservationId}::uuid
        AND status = 'pending'
      RETURNING
        id,
        guild_id,
        creator_discord_user_id,
        interaction_id,
        status,
        category_id,
        chat_channel_id,
        logs_channel_id,
        category_name
    `);
    const completedRow = completed.rows[0];
    if (!completedRow) {
      throw new CreatorSetupError(
        409,
        "setup_conflict",
        "That creator setup could not be completed.",
      );
    }

    return { setup: activeSetup(completedRow) };
  });
}

export async function repairCreatorSetup(input: {
  guildId: string;
  creatorDiscordUserId: string;
  previousCategoryId: string;
  previousChatChannelId: string;
  previousLogsChannelId: string;
  categoryId: string;
  chatChannelId: string;
  logsChannelId: string;
  categoryName: string;
  actorDiscordUserId: string;
  interactionId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
}): Promise<{ setup: CreatorSetup }> {
  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`discord-creator-setup:${input.guildId}:${input.creatorDiscordUserId}`},
          0
        )
      )
    `);

    const result = await tx.execute<SetupRow>(sql`
      SELECT
        id,
        guild_id,
        creator_discord_user_id,
        created_by_discord_user_id,
        interaction_id,
        status,
        category_id,
        chat_channel_id,
        logs_channel_id,
        category_name,
        creator_user_id,
        linked_by_discord_user_id,
        link_interaction_id
      FROM discord_creator_setups
      WHERE guild_id = ${input.guildId}
        AND creator_discord_user_id = ${input.creatorDiscordUserId}
      FOR UPDATE
    `);
    const row = result.rows[0];
    if (!row || row.status !== "active") {
      throw new CreatorSetupError(
        404,
        "setup_not_found",
        "That creator does not have an active setup to repair.",
      );
    }

    const current = activeSetup(row);
    const alreadyRepaired =
      current.categoryId === input.categoryId &&
      current.chatChannelId === input.chatChannelId &&
      current.logsChannelId === input.logsChannelId &&
      current.categoryName === input.categoryName;
    if (alreadyRepaired) {
      return { setup: current };
    }

    if (
      current.categoryId !== input.previousCategoryId ||
      current.chatChannelId !== input.previousChatChannelId ||
      current.logsChannelId !== input.previousLogsChannelId
    ) {
      throw new CreatorSetupError(
        409,
        "setup_conflict",
        "That creator setup changed while Discord channels were being repaired.",
      );
    }

    const updated = await tx.execute<SetupRow>(sql`
      UPDATE discord_creator_setups
      SET category_id = ${input.categoryId},
          chat_channel_id = ${input.chatChannelId},
          logs_channel_id = ${input.logsChannelId},
          category_name = ${input.categoryName},
          completed_at = now()
      WHERE id = ${row.id}::uuid
        AND status = 'active'
        AND category_id = ${input.previousCategoryId}
        AND chat_channel_id = ${input.previousChatChannelId}
        AND logs_channel_id = ${input.previousLogsChannelId}
      RETURNING
        id,
        guild_id,
        creator_discord_user_id,
        created_by_discord_user_id,
        interaction_id,
        status,
        category_id,
        chat_channel_id,
        logs_channel_id,
        category_name,
        creator_user_id,
        linked_by_discord_user_id,
        link_interaction_id
    `);
    const repaired = updated.rows[0];
    if (!repaired) {
      throw new CreatorSetupError(
        409,
        "setup_conflict",
        "That creator setup changed while Discord channels were being repaired.",
      );
    }

    await tx.insert(admin_audit_events).values({
      admin_user_id: null,
      event_type: "discord_creator_setup_repaired",
      target_user_id: repaired.creator_user_id,
      metadata: {
        apiKeyId: input.apiKeyId,
        apiKeyPrefix: input.apiKeyPrefix,
        setupId: repaired.id,
        guildId: input.guildId,
        creatorDiscordUserId: input.creatorDiscordUserId,
        actorDiscordUserId: input.actorDiscordUserId,
        interactionId: input.interactionId,
        previousCategoryId: input.previousCategoryId,
        previousChatChannelId: input.previousChatChannelId,
        previousLogsChannelId: input.previousLogsChannelId,
        categoryId: input.categoryId,
        chatChannelId: input.chatChannelId,
        logsChannelId: input.logsChannelId,
      },
    });

    return { setup: activeSetup(repaired) };
  });
}

export async function cancelCreatorSetup(
  reservationId: string,
): Promise<{ cancelled: true }> {
  await adminDrizzle.execute(sql`
    DELETE FROM discord_creator_setups
    WHERE id = ${reservationId}::uuid
      AND status = 'pending'
  `);
  return { cancelled: true };
}
