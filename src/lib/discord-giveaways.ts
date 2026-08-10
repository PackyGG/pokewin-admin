import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import { account, user } from "@/lib/db-schema/main/schema";

const MIN_DURATION_MS = 60_000;
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DISCORD_EPOCH_MS = BigInt("1420070400000");
export const MINIMUM_PACKY_ACCOUNT_AGE_DAYS = 5;
export const MINIMUM_DISCORD_ACCOUNT_AGE_DAYS = 90;

export type GiveawayEntryRequirement =
  | "none"
  | "linked_packy_account"
  | "established_linked_packy_account";

export type GiveawayFailureCode =
  | "giveaway_not_found"
  | "giveaway_conflict"
  | "giveaway_not_active"
  | "giveaway_not_ended"
  | "giveaway_requirement_not_met"
  | "winner_not_found"
  | "no_eligible_entries";

export class GiveawayError extends Error {
  constructor(
    readonly code: GiveawayFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "GiveawayError";
  }
}

type GiveawayRow = {
  id: string;
  interaction_id: string;
  guild_id: string;
  channel_id: string;
  creator_discord_user_id: string;
  prize: string;
  winner_count: number;
  entry_requirement: GiveawayEntryRequirement;
  ends_at: Date | string;
  status: "pending_message" | "active" | "ended" | "cancelled";
  discord_message_id: string | null;
  revision: number;
};

export type DiscordGiveawayState = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  creatorDiscordUserId: string;
  prize: string;
  winnerCount: number;
  entryRequirement: GiveawayEntryRequirement;
  endsAt: string;
  status: GiveawayRow["status"];
  revision: number;
  entryCount: number;
  winnerDiscordUserIds: string[];
};

export type DiscordGiveawayDeliveryJob = DiscordGiveawayState & {
  leaseToken: string;
  attempt: number;
  kind: "create" | "update";
};

function discordAccountCreatedAtMs(discordUserId: string): number | null {
  try {
    const snowflake = BigInt(discordUserId);
    if (snowflake <= BigInt(0)) return null;
    return Number((snowflake >> BigInt(22)) + DISCORD_EPOCH_MS);
  } catch {
    return null;
  }
}

function discordAccountMeetsMinimumAge(discordUserId: string, now = Date.now()): boolean {
  const createdAt = discordAccountCreatedAtMs(discordUserId);
  return createdAt !== null
    && createdAt <= now - MINIMUM_DISCORD_ACCOUNT_AGE_DAYS * DAY_MS;
}

async function establishedEligibleDiscordUserIds(
  discordUserIds: string[],
  now = Date.now(),
): Promise<Set<string>> {
  const oldEnoughDiscordIds = [...new Set(discordUserIds)]
    .filter((discordUserId) => discordAccountMeetsMinimumAge(discordUserId, now));
  if (oldEnoughDiscordIds.length === 0) return new Set();

  const eligible = new Set<string>();
  const prodReadDb = getProdReadDrizzleDb();
  const packyCreatedBefore = now - MINIMUM_PACKY_ACCOUNT_AGE_DAYS * DAY_MS;
  // Keep the production-read query bounded for unusually large giveaways.
  for (let offset = 0; offset < oldEnoughDiscordIds.length; offset += 500) {
    const batch = oldEnoughDiscordIds.slice(offset, offset + 500);
    const linkedAccounts = await prodReadDb
      .select({
        discordUserId: account.accountId,
        packyCreatedAt: user.created_at,
      })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(and(
        eq(account.providerId, "discord"),
        inArray(account.accountId, batch),
      ));
    for (const linkedAccount of linkedAccounts) {
      const createdAt = Date.parse(linkedAccount.packyCreatedAt);
      if (Number.isFinite(createdAt) && createdAt <= packyCreatedBefore) {
        eligible.add(linkedAccount.discordUserId);
      }
    }
  }
  return eligible;
}

function stateFromRow(
  row: GiveawayRow,
  entryCount: number,
  winnerDiscordUserIds: string[],
): DiscordGiveawayState {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.discord_message_id,
    creatorDiscordUserId: row.creator_discord_user_id,
    prize: row.prize,
    winnerCount: row.winner_count,
    entryRequirement: row.entry_requirement,
    endsAt: new Date(row.ends_at).toISOString(),
    status: row.status,
    revision: row.revision,
    entryCount,
    winnerDiscordUserIds,
  };
}

async function loadState(
  executor: Pick<typeof adminDrizzle, "execute">,
  giveawayId: string,
): Promise<DiscordGiveawayState> {
  const result = await executor.execute<GiveawayRow & { entry_count: number }>(sql`
    SELECT
      giveaway.*,
      (SELECT count(*)::integer FROM discord_giveaway_entries AS entry
       WHERE entry.giveaway_id = giveaway.id) AS entry_count
    FROM discord_giveaways AS giveaway
    WHERE giveaway.id = ${giveawayId}::uuid
  `);
  const row = result.rows[0];
  if (!row) throw new GiveawayError("giveaway_not_found", "Giveaway not found.");
  const winners = await executor.execute<{ discord_user_id: string }>(sql`
    SELECT discord_user_id
    FROM discord_giveaway_winners
    WHERE giveaway_id = ${giveawayId}::uuid AND active
    ORDER BY position
  `);
  return stateFromRow(row, row.entry_count, winners.rows.map((winner) => winner.discord_user_id));
}

export async function createDiscordGiveaway(input: {
  interactionId: string;
  guildId: string;
  channelId: string;
  creatorDiscordUserId: string;
  prize: string;
  winnerCount: number;
  entryRequirement?: GiveawayEntryRequirement;
  endsAt: string;
}): Promise<DiscordGiveawayState> {
  const prize = input.prize.trim();
  const entryRequirement = input.entryRequirement ?? "none";
  const endsAt = new Date(input.endsAt);
  const durationMs = endsAt.getTime() - Date.now();
  if (!prize || prize.length > 1_000) {
    throw new GiveawayError("giveaway_conflict", "Prize must contain 1 to 1,000 characters.");
  }
  if (!Number.isInteger(input.winnerCount) || input.winnerCount < 1 || input.winnerCount > 20) {
    throw new GiveawayError("giveaway_conflict", "Winner count must be between 1 and 20.");
  }
  if (
    entryRequirement !== "none"
    && entryRequirement !== "linked_packy_account"
    && entryRequirement !== "established_linked_packy_account"
  ) {
    throw new GiveawayError("giveaway_conflict", "Unsupported giveaway entry requirement.");
  }
  if (!Number.isFinite(endsAt.getTime()) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
    throw new GiveawayError("giveaway_conflict", "Giveaway duration must be between one minute and one year.");
  }

  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO discord_giveaways (
        interaction_id,
        guild_id,
        channel_id,
        creator_discord_user_id,
        prize,
        winner_count,
        entry_requirement,
        ends_at
      ) VALUES (
        ${input.interactionId},
        ${input.guildId},
        ${input.channelId},
        ${input.creatorDiscordUserId},
        ${prize},
        ${input.winnerCount},
        ${entryRequirement},
        ${endsAt.toISOString()}
      )
      ON CONFLICT (interaction_id) DO NOTHING
    `);
    const existing = await tx.execute<GiveawayRow>(sql`
      SELECT * FROM discord_giveaways
      WHERE interaction_id = ${input.interactionId}
      FOR UPDATE
    `);
    const row = existing.rows[0];
    if (!row) throw new GiveawayError("giveaway_conflict", "Giveaway could not be created.");
    if (
      row.guild_id !== input.guildId
      || row.channel_id !== input.channelId
      || row.creator_discord_user_id !== input.creatorDiscordUserId
      || row.prize !== prize
      || row.winner_count !== input.winnerCount
      || row.entry_requirement !== entryRequirement
      || new Date(row.ends_at).getTime() !== endsAt.getTime()
    ) {
      throw new GiveawayError("giveaway_conflict", "This interaction already created a different giveaway.");
    }
    return stateFromRow(row, 0, []);
  });
}

export async function enterDiscordGiveaway(input: {
  giveawayId: string;
  guildId: string;
  channelId: string;
  discordUserId: string;
}): Promise<{ entered: boolean; entryCount: number }> {
  return adminDrizzle.transaction(async (tx) => {
    const giveaway = await tx.execute<Pick<
      GiveawayRow,
      "guild_id" | "channel_id" | "status" | "entry_requirement"
    > & { open: boolean }>(sql`
      SELECT guild_id, channel_id, status, entry_requirement, (ends_at > now()) AS open
      FROM discord_giveaways
      WHERE id = ${input.giveawayId}::uuid
      FOR UPDATE
    `);
    const row = giveaway.rows[0];
    if (!row) throw new GiveawayError("giveaway_not_found", "Giveaway not found.");
    if (
      row.guild_id !== input.guildId
      || row.channel_id !== input.channelId
      || row.status !== "active"
      || !row.open
    ) throw new GiveawayError("giveaway_not_active", "This giveaway is no longer accepting entries.");

    if (row.entry_requirement === "linked_packy_account") {
      const prodReadDb = getProdReadDrizzleDb();
      const [linkedAccount] = await prodReadDb
        .select({ accountId: account.accountId })
        .from(account)
        .where(and(
          eq(account.providerId, "discord"),
          eq(account.accountId, input.discordUserId),
        ))
        .limit(1);
      if (!linkedAccount) {
        throw new GiveawayError(
          "giveaway_requirement_not_met",
          "A linked Packy.GG account is required to enter this giveaway.",
        );
      }
    }
    if (row.entry_requirement === "established_linked_packy_account") {
      const eligible = await establishedEligibleDiscordUserIds([input.discordUserId]);
      if (!eligible.has(input.discordUserId)) {
        throw new GiveawayError(
          "giveaway_requirement_not_met",
          `A linked Packy.GG account aged ${MINIMUM_PACKY_ACCOUNT_AGE_DAYS}+ days and a Discord account aged ${MINIMUM_DISCORD_ACCOUNT_AGE_DAYS}+ days are required.`,
        );
      }
    }

    const inserted = await tx.execute<{ discord_user_id: string }>(sql`
      INSERT INTO discord_giveaway_entries (giveaway_id, discord_user_id)
      VALUES (${input.giveawayId}::uuid, ${input.discordUserId})
      ON CONFLICT (giveaway_id, discord_user_id) DO NOTHING
      RETURNING discord_user_id
    `);
    const count = await tx.execute<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM discord_giveaway_entries
      WHERE giveaway_id = ${input.giveawayId}::uuid
    `);
    return { entered: inserted.rows.length === 1, entryCount: count.rows[0]?.count ?? 0 };
  });
}

async function finalizeDueGiveaway(giveawayId: string): Promise<void> {
  await adminDrizzle.transaction(async (tx) => {
    const locked = await tx.execute<GiveawayRow>(sql`
      SELECT * FROM discord_giveaways
      WHERE id = ${giveawayId}::uuid AND status = 'active' AND ends_at <= now()
      FOR UPDATE
    `);
    const giveaway = locked.rows[0];
    if (!giveaway) return;
    let candidateRows: { discord_user_id: string }[];
    if (giveaway.entry_requirement === "established_linked_packy_account") {
      const pool = await tx.execute<{ discord_user_id: string }>(sql`
        SELECT discord_user_id
        FROM discord_giveaway_entries
        WHERE giveaway_id = ${giveawayId}::uuid
        ORDER BY random()
      `);
      const eligible = await establishedEligibleDiscordUserIds(
        pool.rows.map((candidate) => candidate.discord_user_id),
      );
      candidateRows = pool.rows
        .filter((candidate) => eligible.has(candidate.discord_user_id))
        .slice(0, giveaway.winner_count);
    } else {
      const candidates = await tx.execute<{ discord_user_id: string }>(sql`
        SELECT discord_user_id
        FROM discord_giveaway_entries
        WHERE giveaway_id = ${giveawayId}::uuid
        ORDER BY random()
        LIMIT ${giveaway.winner_count}
      `);
      candidateRows = candidates.rows;
    }
    const revision = giveaway.revision + 1;
    for (const [index, candidate] of candidateRows.entries()) {
      await tx.execute(sql`
        INSERT INTO discord_giveaway_winners (
          giveaway_id, revision, position, discord_user_id
        ) VALUES (
          ${giveawayId}::uuid, ${revision}, ${index + 1}, ${candidate.discord_user_id}
        )
      `);
    }
    await tx.execute(sql`
      UPDATE discord_giveaways
      SET
        status = 'ended',
        ended_at = now(),
        revision = ${revision},
        delivery_status = 'pending',
        attempt_count = 0,
        available_at = now(),
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        updated_at = now()
      WHERE id = ${giveawayId}::uuid
    `);
  });
}

async function finalizeDueGiveaways(limit: number): Promise<void> {
  const due = await adminDrizzle.execute<{ id: string }>(sql`
    SELECT id::text
    FROM discord_giveaways
    WHERE status = 'active' AND ends_at <= now()
    ORDER BY ends_at, id
    LIMIT ${limit}
  `);
  for (const giveaway of due.rows) await finalizeDueGiveaway(giveaway.id);
  await adminDrizzle.execute(sql`
    UPDATE discord_giveaways
    SET
      status = 'cancelled',
      delivery_status = 'delivered',
      last_error_code = 'expired_before_publish',
      last_error_message = 'The giveaway expired before its initial Discord message was delivered.',
      updated_at = now()
    WHERE status = 'pending_message' AND ends_at <= now()
  `);
}

export async function rerollDiscordGiveaway(input: {
  interactionId: string;
  giveawayId: string;
  guildId: string;
  actorDiscordUserId: string;
  winnerDiscordUserId?: string;
}): Promise<DiscordGiveawayState> {
  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`discord-giveaway-reroll:${input.interactionId}`}, 0)
      )
    `);
    const previous = await tx.execute<{
      giveaway_id: string;
      actor_discord_user_id: string;
      target_winner_discord_user_id: string | null;
    }>(sql`
      SELECT giveaway_id::text, actor_discord_user_id, target_winner_discord_user_id
      FROM discord_giveaway_rerolls
      WHERE interaction_id = ${input.interactionId}
    `);
    const prior = previous.rows[0];
    if (prior) {
      if (
        prior.giveaway_id !== input.giveawayId
        || prior.actor_discord_user_id !== input.actorDiscordUserId
        || prior.target_winner_discord_user_id !== (input.winnerDiscordUserId ?? null)
      ) throw new GiveawayError("giveaway_conflict", "This interaction already rerolled a different giveaway.");
      return loadState(tx, input.giveawayId);
    }
    const locked = await tx.execute<GiveawayRow>(sql`
      SELECT * FROM discord_giveaways
      WHERE id = ${input.giveawayId}::uuid
      FOR UPDATE
    `);
    const giveaway = locked.rows[0];
    if (!giveaway || giveaway.guild_id !== input.guildId) {
      throw new GiveawayError("giveaway_not_found", "Giveaway not found.");
    }
    if (giveaway.status !== "ended") {
      throw new GiveawayError("giveaway_not_ended", "Only an ended giveaway can be rerolled.");
    }
    const active = await tx.execute<{ position: number; discord_user_id: string }>(sql`
      SELECT position, discord_user_id
      FROM discord_giveaway_winners
      WHERE giveaway_id = ${input.giveawayId}::uuid AND active
      ORDER BY position
      FOR UPDATE
    `);
    const replaced = input.winnerDiscordUserId
      ? active.rows.filter((winner) => winner.discord_user_id === input.winnerDiscordUserId)
      : active.rows;
    if (input.winnerDiscordUserId && replaced.length === 0) {
      throw new GiveawayError("winner_not_found", "That user is not a current winner.");
    }
    if (replaced.length === 0) {
      throw new GiveawayError("winner_not_found", "This giveaway has no winners to reroll.");
    }
    const candidatePool = await tx.execute<{ discord_user_id: string }>(sql`
      SELECT entry.discord_user_id
      FROM discord_giveaway_entries AS entry
      WHERE entry.giveaway_id = ${input.giveawayId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM discord_giveaway_winners AS winner
          WHERE winner.giveaway_id = entry.giveaway_id
            AND winner.active
            AND winner.discord_user_id = entry.discord_user_id
        )
      ORDER BY random()
      ${giveaway.entry_requirement === "established_linked_packy_account"
        ? sql``
        : sql`LIMIT ${replaced.length}`}
    `);
    let candidateRows = candidatePool.rows;
    if (giveaway.entry_requirement === "established_linked_packy_account") {
      const eligible = await establishedEligibleDiscordUserIds(
        candidateRows.map((candidate) => candidate.discord_user_id),
      );
      candidateRows = candidateRows
        .filter((candidate) => eligible.has(candidate.discord_user_id))
        .slice(0, replaced.length);
    }
    if (candidateRows.length !== replaced.length) {
      throw new GiveawayError("no_eligible_entries", "There are not enough different entrants to reroll.");
    }
    const revision = giveaway.revision + 1;
    for (const [index, oldWinner] of replaced.entries()) {
      await tx.execute(sql`
        UPDATE discord_giveaway_winners
        SET active = false
        WHERE giveaway_id = ${input.giveawayId}::uuid
          AND position = ${oldWinner.position}
          AND active
      `);
      await tx.execute(sql`
        INSERT INTO discord_giveaway_winners (
          giveaway_id, revision, position, discord_user_id
        ) VALUES (
          ${input.giveawayId}::uuid,
          ${revision},
          ${oldWinner.position},
          ${candidateRows[index].discord_user_id}
        )
      `);
    }
    await tx.execute(sql`
      UPDATE discord_giveaways
      SET
        revision = ${revision},
        delivery_status = 'pending',
        attempt_count = 0,
        available_at = now(),
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      WHERE id = ${input.giveawayId}::uuid
    `);
    await tx.execute(sql`
      INSERT INTO discord_giveaway_rerolls (
        interaction_id,
        giveaway_id,
        actor_discord_user_id,
        target_winner_discord_user_id,
        revision
      ) VALUES (
        ${input.interactionId},
        ${input.giveawayId}::uuid,
        ${input.actorDiscordUserId},
        ${input.winnerDiscordUserId ?? null},
        ${revision}
      )
    `);
    return loadState(tx, input.giveawayId);
  });
}

export async function claimDiscordGiveawayJobs(input: {
  workerId: string;
  limit: number;
}): Promise<DiscordGiveawayDeliveryJob[]> {
  const workerId = input.workerId.trim().slice(0, 120);
  if (!workerId) throw new Error("workerId is required.");
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit)));
  await finalizeDueGiveaways(limit);

  const claimed = await adminDrizzle.execute<GiveawayRow & {
    lease_token: string;
    attempt_count: number;
  }>(sql`
    WITH exhausted AS (
      UPDATE discord_giveaways
      SET
        delivery_status = 'dead',
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        last_error_code = COALESCE(last_error_code, 'lease_expired'),
        last_error_message = COALESCE(last_error_message, 'The final giveaway delivery lease expired.'),
        updated_at = now()
      WHERE delivery_status = 'leased'
        AND leased_until < now()
        AND attempt_count >= max_attempts
      RETURNING id
    ),
    candidates AS (
      SELECT id
      FROM discord_giveaways
      WHERE available_at <= now()
        AND delivered_revision < revision
        AND attempt_count < max_attempts
        AND status IN ('pending_message', 'ended')
        AND (
          delivery_status = 'pending'
          OR (delivery_status = 'leased' AND leased_until < now())
        )
      ORDER BY available_at, created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE discord_giveaways AS giveaway
    SET
      delivery_status = 'leased',
      attempt_count = giveaway.attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_owner = ${workerId},
      leased_until = now() + interval '90 seconds',
      updated_at = now()
    FROM candidates
    WHERE giveaway.id = candidates.id
    RETURNING giveaway.*
  `);

  const jobs: DiscordGiveawayDeliveryJob[] = [];
  for (const row of claimed.rows) {
    const state = await loadState(adminDrizzle, row.id);
    jobs.push({
      ...state,
      leaseToken: row.lease_token,
      attempt: row.attempt_count,
      kind: row.status === "pending_message" ? "create" : "update",
    });
  }
  return jobs;
}

export async function acknowledgeDiscordGiveawayJob(input: {
  id: string;
  leaseToken: string;
  revision: number;
  status: "delivered" | "failed";
  discordMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<{ status: "active" | "ended" | "pending" | "dead" }> {
  if (input.status === "delivered") {
    const result = await adminDrizzle.execute<{ status: "active" | "ended" }>(sql`
      UPDATE discord_giveaways
      SET
        status = CASE WHEN status = 'pending_message' THEN 'active' ELSE status END,
        discord_message_id = COALESCE(discord_message_id, ${input.discordMessageId?.trim().slice(0, 30) || null}),
        delivered_revision = ${input.revision},
        delivery_status = 'delivered',
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      WHERE id = ${input.id}::uuid
        AND lease_token = ${input.leaseToken}::uuid
        AND revision = ${input.revision}
        AND delivery_status = 'leased'
        AND (
          (status = 'pending_message' AND discord_message_id IS NULL)
          OR
          (status = 'ended' AND discord_message_id = ${input.discordMessageId?.trim().slice(0, 30) || null})
        )
      RETURNING status
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Giveaway delivery lease not found.");
    return { status: row.status };
  }

  const result = await adminDrizzle.execute<{ delivery_status: "pending" | "dead" }>(sql`
    UPDATE discord_giveaways
    SET
      delivery_status = CASE WHEN attempt_count >= max_attempts THEN 'dead' ELSE 'pending' END,
      available_at = now() + (
        LEAST(300, power(2, LEAST(attempt_count, 8))::int) * interval '1 second'
      ),
      lease_token = NULL,
      lease_owner = NULL,
      leased_until = NULL,
      last_error_code = ${input.errorCode?.trim().slice(0, 80) || null},
      last_error_message = ${input.errorMessage?.trim().slice(0, 500) || null},
      updated_at = now()
    WHERE id = ${input.id}::uuid
      AND lease_token = ${input.leaseToken}::uuid
      AND revision = ${input.revision}
      AND delivery_status = 'leased'
    RETURNING delivery_status
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Giveaway delivery lease not found.");
  return { status: row.delivery_status };
}
