import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { account, user } from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";

export const CREATOR_SETUP_GUILD_ID = "1402743122789929022";

type SetupRow = {
  id: string;
  guild_id: string;
  creator_discord_user_id: string;
  interaction_id: string;
  status: "pending" | "active";
  category_id: string | null;
  chat_channel_id: string | null;
  logs_channel_id: string | null;
  category_name: string | null;
};

export type CreatorSetup = {
  guildId: string;
  creatorDiscordUserId: string;
  categoryId: string;
  chatChannelId: string;
  logsChannelId: string;
  categoryName: string;
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
  };
}

async function requireLinkedCreator(discordUserId: string): Promise<void> {
  const db = getProdReadDrizzleDb();
  const [linked] = await db
    .select({
      role: user.role,
      roles: user.roles,
    })
    .from(account)
    .innerJoin(user, eq(user.id, account.userId))
    .where(
      and(
        eq(account.accountId, discordUserId),
        eq(account.providerId, "discord"),
      ),
    )
    .limit(1);

  if (
    !linked ||
    (linked.role !== "creator" && !(linked.roles ?? []).includes("creator"))
  ) {
    throw new CreatorSetupError(
      404,
      "creator_not_found",
      "That Discord account is not linked to a creator account.",
    );
  }
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
  await requireLinkedCreator(input.creatorDiscordUserId);

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
