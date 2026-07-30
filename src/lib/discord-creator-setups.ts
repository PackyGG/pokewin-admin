import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_audit_events,
  creator_reward_programs,
} from "@/lib/db-schema/admin/schema";
import { account, affiliate_codes, user } from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import { creatorsApi, type CreatorDealResponse } from "@/lib/backend-api";
import { isDiscordBotSuperuser } from "@/lib/discord-bot-superusers";

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
  periodDays: 30;
  generatedAt: string;
  creator: {
    userId: string;
    username: string | null;
    codes: string[];
  };
  totals: CreatorCodeStats;
  byCode: CreatorCodeStats[];
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
  } | null;
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

async function requireActiveCreator(
  creatorUserId: string,
): Promise<{ id: string; username: string | null }> {
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

  if (
    !creator ||
    (creator.role !== "creator" &&
      !(creator.roles ?? []).includes("creator"))
  ) {
    throw new CreatorSetupError(
      404,
      "creator_not_found",
      "That Packy user does not have the active creator role.",
    );
  }
  return { id: creator.id, username: creator.username };
}

async function requireDiscordOwnership(
  discordUserId: string,
  creatorUserId: string,
): Promise<void> {
  const db = getProdReadDrizzleDb();
  const [linked] = await db
    .select({ id: user.id })
    .from(account)
    .innerJoin(user, eq(user.id, account.userId))
    .where(
      and(
        eq(account.accountId, discordUserId),
        eq(account.providerId, "discord"),
      ),
    )
    .limit(1);

  if (!linked || linked.id !== creatorUserId) {
    throw new CreatorSetupError(
      409,
      "creator_mismatch",
      "That Packy creator account belongs to a different Discord account.",
    );
  }
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
}): Promise<SetupRow & { creator_user_id: string }> {
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
  if (
    !isDiscordBotSuperuser(input.actorDiscordUserId) &&
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

export async function getCreatorSetupStats(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
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
      periodDays: 30,
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
        AND acu.created_at >= NOW() - INTERVAL '30 days'
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
          AND lt.created_at >= NOW() - INTERVAL '30 days'
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
        AND created_at >= NOW() - INTERVAL '30 days'
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
    periodDays: 30,
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

function creatorFacingDeal(deal: CreatorDealResponse): NonNullable<CreatorSetupDeal["deal"]> {
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

  return {
    generatedAt: new Date().toISOString(),
    creator: { userId: creator.id, username: creator.username },
    deal: current ? creatorFacingDeal(current) : null,
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
    })
    .from(creator_reward_programs)
    .where(
      and(
        eq(creator_reward_programs.creator_user_id, setup.creator_user_id),
        eq(creator_reward_programs.is_active, true),
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
      !isDiscordBotSuperuser(input.actorDiscordUserId) &&
      input.actorDiscordUserId !== setup.creator_discord_user_id &&
      input.actorDiscordUserId !== setup.created_by_discord_user_id
    ) {
      throw new CreatorSetupError(
        403,
        "setup_actor_forbidden",
        "Only this creator or the staff member who created the section can link it.",
      );
    }

    await requireActiveCreator(input.creatorUserId);
    if (
      !isDiscordBotSuperuser(input.actorDiscordUserId) &&
      input.actorDiscordUserId === setup.creator_discord_user_id &&
      input.actorDiscordUserId !== setup.created_by_discord_user_id
    ) {
      await requireDiscordOwnership(
        setup.creator_discord_user_id,
        input.creatorUserId,
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
      return {
        status: "already_linked" as const,
        setup: linkedSetup(setup),
      };
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

    const updated = await tx.execute<SetupRow>(sql`
      UPDATE discord_creator_setups
      SET creator_user_id = ${input.creatorUserId},
          linked_by_discord_user_id = ${input.actorDiscordUserId},
          link_interaction_id = ${input.interactionId},
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
