import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { admin_audit_events } from "@/lib/db-schema/admin/schema";
import { account, user } from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";

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

async function requireLinkedCreator(
  discordUserId: string,
  creatorUserId?: string,
): Promise<void> {
  const db = getProdReadDrizzleDb();
  const [linked] = await db
    .select({
      id: user.id,
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
      creatorUserId
        ? "That Packy creator account is not linked to this Discord account."
        : "That Discord account is not linked to a creator account.",
    );
  }
  if (creatorUserId && linked.id !== creatorUserId) {
    throw new CreatorSetupError(
      409,
      "creator_mismatch",
      "That Packy creator account belongs to a different Discord account.",
    );
  }
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
      input.actorDiscordUserId !== setup.creator_discord_user_id &&
      input.actorDiscordUserId !== setup.created_by_discord_user_id
    ) {
      throw new CreatorSetupError(
        403,
        "setup_actor_forbidden",
        "Only this creator or the staff member who created the section can link it.",
      );
    }

    await requireLinkedCreator(
      setup.creator_discord_user_id,
      input.creatorUserId,
    );

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
