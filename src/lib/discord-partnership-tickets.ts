import "server-only";

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";

export const PARTNERSHIP_GUILD_ID = "1438216946318442683";
export const PARTNERSHIP_PANEL_CHANNEL_ID = "1447322856818999337";
export const PARTNERSHIP_OPEN_CATEGORY_ID = "1510419019159834704";
export const PARTNERSHIP_OFFERED_CATEGORY_ID = "1496627221689794741";
export const PARTNERSHIP_TRANSCRIPT_CHANNEL_ID = "1513275149523091486";

type TicketStatus =
  | "provisioning" | "open" | "offer_pending" | "offered"
  | "close_pending" | "cancelled" | "closed";
type OperationType = "offer" | "close";

type TicketRow = {
  id: string; guild_id: string; source_channel_id: string;
  applicant_discord_user_id: string; applicant_username: string;
  applicant_display_name: string; submit_interaction_id: string;
  social_media_links: string; current_past_partner_sites: string;
  stats_expectations: string; additional_notes: string | null;
  status: TicketStatus; ticket_channel_id: string | null;
  current_category_id: string | null; initial_message_id: string | null;
  created_at: string; updated_at: string;
};

type OperationRow = {
  id: string; ticket_id: string; operation_type: OperationType;
  interaction_id: string; actor_discord_user_id: string;
  status: "pending" | "completed" | "failed"; from_status: TicketStatus;
  target_category_id: string | null;
  observed_channel_id: string | null; observed_category_id: string | null;
};

function publicOperation(row: OperationRow) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    operationType: row.operation_type,
    interactionId: row.interaction_id,
    actorDiscordUserId: row.actor_discord_user_id,
    status: row.status,
    fromStatus: row.from_status,
    targetCategoryId: row.target_category_id,
    observedChannelId: row.observed_channel_id,
    observedCategoryId: row.observed_category_id,
  };
}

export class PartnershipTicketError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "PartnershipTicketError";
  }
}

function publicTicket(row: TicketRow) {
  return {
    id: row.id,
    guildId: row.guild_id,
    sourceChannelId: row.source_channel_id,
    applicantDiscordUserId: row.applicant_discord_user_id,
    applicantUsername: row.applicant_username,
    applicantDisplayName: row.applicant_display_name,
    socialMediaLinks: row.social_media_links,
    currentPastPartnerSites: row.current_past_partner_sites,
    statsExpectations: row.stats_expectations,
    additionalNotes: row.additional_notes,
    status: row.status,
    ticketChannelId: row.ticket_channel_id,
    currentCategoryId: row.current_category_id,
    initialMessageId: row.initial_message_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function audit(tx: Parameters<Parameters<typeof adminDrizzle.transaction>[0]>[0], eventType: string, metadata: Record<string, unknown>) {
  await tx.execute(sql`
    INSERT INTO admin_audit_events (admin_user_id, event_type, metadata)
    VALUES (NULL, ${eventType}, ${JSON.stringify(metadata)}::jsonb)
  `);
}

const ticketColumns = sql`
  id::text, guild_id, source_channel_id, applicant_discord_user_id,
  applicant_username, applicant_display_name, submit_interaction_id,
  social_media_links, current_past_partner_sites, stats_expectations,
  additional_notes, status, ticket_channel_id, current_category_id,
  initial_message_id, created_at::text, updated_at::text
`;

export type PreparePartnershipTicketInput = {
  guildId: string; sourceChannelId: string; applicantDiscordUserId: string;
  applicantUsername: string; applicantDisplayName: string; interactionId: string;
  socialMediaLinks: string; currentPastPartnerSites: string;
  statsExpectations: string; additionalNotes?: string | null;
  apiKeyId: string; apiKeyPrefix: string;
};

export async function preparePartnershipTicket(input: PreparePartnershipTicketInput) {
  return adminDrizzle.transaction(async (tx) => {
    for (const lock of [
      `partnership-ticket:${input.guildId}:${input.applicantDiscordUserId}`,
      `partnership-ticket-interaction:${input.interactionId}`,
    ]) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
    }

    const byInteraction = await tx.execute<TicketRow>(sql`
      SELECT ${ticketColumns} FROM discord_partnership_tickets
      WHERE submit_interaction_id = ${input.interactionId} FOR UPDATE
    `);
    const replay = byInteraction.rows[0];
    if (replay) {
      if (
        replay.guild_id !== input.guildId ||
        replay.source_channel_id !== input.sourceChannelId ||
        replay.applicant_discord_user_id !== input.applicantDiscordUserId ||
        replay.social_media_links !== input.socialMediaLinks ||
        replay.current_past_partner_sites !== input.currentPastPartnerSites ||
        replay.stats_expectations !== input.statsExpectations ||
        replay.additional_notes !== (input.additionalNotes ?? null)
      ) {
        throw new PartnershipTicketError(409, "idempotency_conflict", "That interaction is already assigned to another application.");
      }
      return { status: replay.status === "provisioning" ? "ready" as const : "existing" as const, ticket: publicTicket(replay) };
    }

    const existing = await tx.execute<TicketRow>(sql`
      SELECT ${ticketColumns} FROM discord_partnership_tickets
      WHERE guild_id = ${input.guildId}
        AND applicant_discord_user_id = ${input.applicantDiscordUserId}
        AND status NOT IN ('closed', 'cancelled')
      FOR UPDATE
    `);
    if (existing.rows[0]) return { status: "existing" as const, ticket: publicTicket(existing.rows[0]) };

    const inserted = await tx.execute<TicketRow>(sql`
      INSERT INTO discord_partnership_tickets (
        guild_id, source_channel_id, applicant_discord_user_id,
        applicant_username, applicant_display_name, submit_interaction_id,
        social_media_links, current_past_partner_sites, stats_expectations,
        additional_notes
      ) VALUES (
        ${input.guildId}, ${input.sourceChannelId}, ${input.applicantDiscordUserId},
        ${input.applicantUsername}, ${input.applicantDisplayName}, ${input.interactionId},
        ${input.socialMediaLinks}, ${input.currentPastPartnerSites}, ${input.statsExpectations},
        ${input.additionalNotes ?? null}
      ) RETURNING ${ticketColumns}
    `);
    const ticket = inserted.rows[0]!;
    await audit(tx, "discord_partnership_ticket_created", {
      apiKeyId: input.apiKeyId, apiKeyPrefix: input.apiKeyPrefix,
      ticketId: ticket.id, guildId: input.guildId,
      applicantDiscordUserId: input.applicantDiscordUserId,
      interactionId: input.interactionId,
    });
    return { status: "ready" as const, ticket: publicTicket(ticket) };
  });
}

export async function completePartnershipTicket(input: {
  ticketId: string; guildId: string; applicantDiscordUserId: string;
  ticketChannelId: string; categoryId: string; initialMessageId: string;
  apiKeyId: string; apiKeyPrefix: string;
}) {
  return adminDrizzle.transaction(async (tx) => {
    const result = await tx.execute<TicketRow>(sql`SELECT ${ticketColumns} FROM discord_partnership_tickets WHERE id = ${input.ticketId}::uuid FOR UPDATE`);
    const row = result.rows[0];
    if (!row) throw new PartnershipTicketError(404, "ticket_not_found", "That ticket reservation does not exist.");
    if (row.guild_id !== input.guildId || row.applicant_discord_user_id !== input.applicantDiscordUserId) {
      throw new PartnershipTicketError(409, "ticket_conflict", "The reservation does not match this application.");
    }
    if (input.categoryId !== PARTNERSHIP_OPEN_CATEGORY_ID) throw new PartnershipTicketError(403, "wrong_category", "Tickets must open in the configured category.");
    if (row.status !== "provisioning") {
      if (row.ticket_channel_id === input.ticketChannelId && row.current_category_id === input.categoryId && row.initial_message_id === input.initialMessageId) {
        return { status: "existing" as const, ticket: publicTicket(row) };
      }
      throw new PartnershipTicketError(409, "ticket_conflict", "That reservation was completed differently.");
    }
    const updated = await tx.execute<TicketRow>(sql`
      UPDATE discord_partnership_tickets SET status = 'open',
        ticket_channel_id = ${input.ticketChannelId}, current_category_id = ${input.categoryId},
        initial_message_id = ${input.initialMessageId}, provisioned_at = now(),
        updated_at = now(), version = version + 1,
        last_error_step = NULL, last_error_code = NULL, last_error_message = NULL, last_error_at = NULL
      WHERE id = ${input.ticketId}::uuid AND status = 'provisioning'
      RETURNING ${ticketColumns}
    `);
    const ticket = updated.rows[0]!;
    await audit(tx, "discord_partnership_ticket_provisioned", { apiKeyId: input.apiKeyId, apiKeyPrefix: input.apiKeyPrefix, ticketId: ticket.id, ticketChannelId: input.ticketChannelId });
    return { status: "completed" as const, ticket: publicTicket(ticket) };
  });
}

export async function cancelPartnershipTicket(input: { ticketId: string; interactionId: string; apiKeyId: string; apiKeyPrefix: string }) {
  return adminDrizzle.transaction(async (tx) => {
    const result = await tx.execute<TicketRow>(sql`SELECT ${ticketColumns} FROM discord_partnership_tickets WHERE id = ${input.ticketId}::uuid FOR UPDATE`);
    const row = result.rows[0];
    if (!row) throw new PartnershipTicketError(404, "ticket_not_found", "That ticket reservation does not exist.");
    if (row.submit_interaction_id !== input.interactionId) throw new PartnershipTicketError(409, "ticket_conflict", "The interaction does not match this reservation.");
    if (row.status === "cancelled") return { cancelled: true };
    if (row.status !== "provisioning") throw new PartnershipTicketError(409, "ticket_active", "A provisioned ticket cannot be cancelled as a reservation.");
    await tx.execute(sql`UPDATE discord_partnership_tickets SET status='cancelled', cancelled_at=now(), updated_at=now(), version=version+1 WHERE id=${input.ticketId}::uuid`);
    await audit(tx, "discord_partnership_ticket_cancelled", { apiKeyId: input.apiKeyId, apiKeyPrefix: input.apiKeyPrefix, ticketId: input.ticketId, interactionId: input.interactionId });
    return { cancelled: true };
  });
}

export async function preparePartnershipTicketAction(input: {
  ticketId: string; guildId: string; channelId: string; messageId: string;
  actorDiscordUserId: string; interactionId: string; action: OperationType;
  apiKeyId: string; apiKeyPrefix: string;
}) {
  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`partnership-operation:${input.interactionId}`}, 0))`);
    const replayResult = await tx.execute<OperationRow>(sql`SELECT * FROM discord_partnership_ticket_operations WHERE interaction_id=${input.interactionId} FOR UPDATE`);
    const replay = replayResult.rows[0];
    if (replay) {
      if (replay.ticket_id !== input.ticketId || replay.operation_type !== input.action || replay.actor_discord_user_id !== input.actorDiscordUserId) throw new PartnershipTicketError(409, "idempotency_conflict", "That interaction is already assigned to another ticket action.");
      if (replay.status === "failed") throw new PartnershipTicketError(409, "operation_failed", "That interaction's operation failed; start a new action to retry.");
      return { status: replay.status === "completed" ? "completed" as const : "ready" as const, operation: publicOperation(replay) };
    }
    const ticketResult = await tx.execute<TicketRow>(sql`SELECT ${ticketColumns} FROM discord_partnership_tickets WHERE id=${input.ticketId}::uuid FOR UPDATE`);
    const ticket = ticketResult.rows[0];
    if (!ticket) throw new PartnershipTicketError(404, "ticket_not_found", "That partnership ticket does not exist.");
    if (ticket.guild_id !== input.guildId || ticket.ticket_channel_id !== input.channelId || ticket.initial_message_id !== input.messageId) throw new PartnershipTicketError(409, "ticket_context_conflict", "The Discord context does not match this ticket.");
    const allowed = input.action === "offer" ? ticket.status === "open" : ticket.status === "open" || ticket.status === "offered";
    if (!allowed) throw new PartnershipTicketError(409, "invalid_ticket_state", "That action is not available in the ticket's current state.");
    const pendingStatus = input.action === "offer" ? "offer_pending" : "close_pending";
    const targetCategoryId = input.action === "offer" ? PARTNERSHIP_OFFERED_CATEGORY_ID : null;
    const inserted = await tx.execute<OperationRow>(sql`
      INSERT INTO discord_partnership_ticket_operations (ticket_id, operation_type, interaction_id, actor_discord_user_id, from_status, target_category_id)
      VALUES (${input.ticketId}::uuid, ${input.action}, ${input.interactionId}, ${input.actorDiscordUserId}, ${ticket.status}, ${targetCategoryId}) RETURNING *
    `);
    await tx.execute(sql`
      UPDATE discord_partnership_tickets SET status=${pendingStatus}, updated_at=now(), version=version+1,
        close_requested_at=CASE WHEN ${input.action}='close' THEN now() ELSE close_requested_at END
      WHERE id=${input.ticketId}::uuid
    `);
    const operation = inserted.rows[0]!;
    await audit(tx, `discord_partnership_ticket_${input.action}_requested`, { apiKeyId: input.apiKeyId, apiKeyPrefix: input.apiKeyPrefix, ticketId: input.ticketId, operationId: operation.id, actorDiscordUserId: input.actorDiscordUserId, interactionId: input.interactionId });
    return { status: "ready" as const, operation: publicOperation(operation) };
  });
}

export async function completePartnershipTicketAction(input: {
  ticketId: string; operationId: string; observedChannelId: string;
  observedCategoryId?: string; observedChannelDeleted?: boolean;
  apiKeyId: string; apiKeyPrefix: string;
}) {
  return adminDrizzle.transaction(async (tx) => {
    const opResult = await tx.execute<OperationRow>(sql`SELECT * FROM discord_partnership_ticket_operations WHERE id=${input.operationId}::uuid AND ticket_id=${input.ticketId}::uuid FOR UPDATE`);
    const op = opResult.rows[0];
    if (!op) throw new PartnershipTicketError(404, "operation_not_found", "That ticket operation does not exist.");
    if (op.status === "completed") return { status: "completed" as const, operation: publicOperation(op) };
    if (op.status !== "pending") throw new PartnershipTicketError(409, "operation_failed", "That operation has already failed.");
    const ticketResult = await tx.execute<TicketRow>(sql`SELECT ${ticketColumns} FROM discord_partnership_tickets WHERE id=${input.ticketId}::uuid FOR UPDATE`);
    const ticket = ticketResult.rows[0]!;
    if (ticket.ticket_channel_id !== input.observedChannelId) throw new PartnershipTicketError(409, "ticket_context_conflict", "The observed channel does not match this ticket.");
    if (op.operation_type === "offer") {
      if (input.observedCategoryId !== PARTNERSHIP_OFFERED_CATEGORY_ID) throw new PartnershipTicketError(409, "offer_not_moved", "The ticket has not reached the offered category.");
      const moved = await tx.execute(sql`UPDATE discord_partnership_tickets SET status='offered', current_category_id=${PARTNERSHIP_OFFERED_CATEGORY_ID}, offered_at=COALESCE(offered_at,now()), updated_at=now(), version=version+1 WHERE id=${input.ticketId}::uuid AND status='offer_pending'`);
      if (moved.rowCount !== 1) throw new PartnershipTicketError(409, "invalid_ticket_state", "The ticket is no longer waiting for the offer move.");
    } else {
      if (input.observedChannelDeleted !== true) throw new PartnershipTicketError(409, "channel_not_deleted", "The ticket channel must be deleted before close completion.");
      const transcript = await tx.execute<{ status: string }>(sql`SELECT status FROM discord_partnership_transcripts WHERE ticket_id=${input.ticketId}::uuid AND close_operation_id=${input.operationId}::uuid FOR UPDATE`);
      if (transcript.rows[0]?.status !== "delivered") throw new PartnershipTicketError(409, "transcript_not_delivered", "The transcript must be delivered before closing the ticket.");
      const closed = await tx.execute(sql`UPDATE discord_partnership_tickets SET status='closed', closed_at=now(), closed_by_discord_user_id=${op.actor_discord_user_id}, updated_at=now(), version=version+1 WHERE id=${input.ticketId}::uuid AND status='close_pending'`);
      if (closed.rowCount !== 1) throw new PartnershipTicketError(409, "invalid_ticket_state", "The ticket is no longer waiting to close.");
    }
    await tx.execute(sql`UPDATE discord_partnership_ticket_operations SET status='completed', observed_channel_id=${input.observedChannelId}, observed_category_id=${input.observedCategoryId ?? null}, completed_at=now(), updated_at=now() WHERE id=${input.operationId}::uuid`);
    await audit(tx, `discord_partnership_ticket_${op.operation_type}_completed`, { apiKeyId: input.apiKeyId, apiKeyPrefix: input.apiKeyPrefix, ticketId: input.ticketId, operationId: input.operationId });
    return { status: "completed" as const, operation: publicOperation({ ...op, status: "completed" as const }) };
  });
}

export async function failPartnershipTicketAction(input: { ticketId: string; operationId: string; errorCode: string; errorMessage: string; apiKeyId: string; apiKeyPrefix: string }) {
  return adminDrizzle.transaction(async (tx) => {
    const result = await tx.execute<OperationRow>(sql`SELECT * FROM discord_partnership_ticket_operations WHERE id=${input.operationId}::uuid AND ticket_id=${input.ticketId}::uuid FOR UPDATE`);
    const op = result.rows[0];
    if (!op) throw new PartnershipTicketError(404, "operation_not_found", "That ticket operation does not exist.");
    if (op.status === "failed") return { failed: true };
    if (op.status !== "pending") throw new PartnershipTicketError(409, "operation_completed", "A completed operation cannot be failed.");
    if (op.operation_type === "close") {
      const transcript = await tx.execute<{ id: string }>(sql`SELECT id::text FROM discord_partnership_transcripts WHERE close_operation_id=${input.operationId}::uuid`);
      if (transcript.rows[0]) throw new PartnershipTicketError(409, "transcript_started", "A close with a persisted transcript must be repaired instead of failed.");
    }
    await tx.execute(sql`UPDATE discord_partnership_ticket_operations SET status='failed', error_code=${input.errorCode}, error_message=${input.errorMessage}, failed_at=now(), updated_at=now() WHERE id=${input.operationId}::uuid`);
    await tx.execute(sql`UPDATE discord_partnership_tickets SET status=${op.from_status}, last_error_step=${op.operation_type}, last_error_code=${input.errorCode}, last_error_message=${input.errorMessage}, last_error_at=now(), updated_at=now(), version=version+1 WHERE id=${input.ticketId}::uuid AND status IN ('offer_pending','close_pending')`);
    await audit(tx, `discord_partnership_ticket_${op.operation_type}_failed`, { apiKeyId: input.apiKeyId, apiKeyPrefix: input.apiKeyPrefix, ticketId: input.ticketId, operationId: input.operationId, errorCode: input.errorCode });
    return { failed: true };
  });
}

export type TranscriptMessageInput = {
  messageId: string; ordinal: number; authorId: string | null;
  authorUsername: string | null; authorDisplayName: string | null;
  authorAvatarUrl: string | null; content: string | null;
  createdAt: string; editedAt: string | null; referencedMessageId: string | null;
  attachments: unknown[]; embeds: unknown[]; stickers: unknown[];
};

export async function storePartnershipTranscriptBatch(input: { ticketId: string; closeOperationId: string; batchId: string; messages: TranscriptMessageInput[] }) {
  const payloadSha256 = createHash("sha256").update(JSON.stringify(input.messages)).digest("hex");
  return adminDrizzle.transaction(async (tx) => {
    const op = await tx.execute<OperationRow>(sql`SELECT * FROM discord_partnership_ticket_operations WHERE id=${input.closeOperationId}::uuid AND ticket_id=${input.ticketId}::uuid AND operation_type='close' FOR UPDATE`);
    if (!op.rows[0] || op.rows[0].status !== "pending") throw new PartnershipTicketError(409, "close_not_pending", "The ticket is not waiting to close.");
    const transcriptResult = await tx.execute<{ id: string; status: string; close_operation_id: string }>(sql`
      INSERT INTO discord_partnership_transcripts (ticket_id, close_operation_id)
      VALUES (${input.ticketId}::uuid, ${input.closeOperationId}::uuid)
      ON CONFLICT (ticket_id) DO UPDATE SET updated_at=discord_partnership_transcripts.updated_at
      RETURNING id::text, status, close_operation_id::text
    `);
    const transcript = transcriptResult.rows[0]!;
    if (transcript.close_operation_id !== input.closeOperationId) throw new PartnershipTicketError(409, "transcript_conflict", "This ticket already has a transcript for another close operation.");
    if (transcript.status !== "building") throw new PartnershipTicketError(409, "transcript_finalized", "That transcript is already finalized.");
    const batch = await tx.execute<{ payload_sha256: string }>(sql`SELECT payload_sha256 FROM discord_partnership_transcript_batches WHERE batch_id=${input.batchId}::uuid FOR UPDATE`);
    if (batch.rows[0]) {
      if (batch.rows[0].payload_sha256 !== payloadSha256) throw new PartnershipTicketError(409, "idempotency_conflict", "That transcript batch ID has different content.");
      return { status: "existing" as const, transcriptId: transcript.id, accepted: input.messages.length };
    }
    for (const message of input.messages) {
      const inserted = await tx.execute(sql`
        INSERT INTO discord_partnership_transcript_messages (
          transcript_id, message_id, ordinal, author_id, author_username,
          author_display_name, author_avatar_url, content, discord_created_at,
          discord_edited_at, referenced_message_id, attachments, embeds, stickers
        ) VALUES (
          ${transcript.id}::uuid, ${message.messageId}, ${message.ordinal}, ${message.authorId}, ${message.authorUsername},
          ${message.authorDisplayName}, ${message.authorAvatarUrl}, ${message.content}, ${message.createdAt}::timestamptz,
          ${message.editedAt}::timestamptz, ${message.referencedMessageId}, ${JSON.stringify(message.attachments)}::jsonb,
          ${JSON.stringify(message.embeds)}::jsonb, ${JSON.stringify(message.stickers)}::jsonb
        ) ON CONFLICT (transcript_id, message_id) DO NOTHING
      `);
      if (inserted.rowCount === 0) {
        const exact = await tx.execute<{ exact: boolean }>(sql`
          SELECT ordinal=${message.ordinal} AND author_id IS NOT DISTINCT FROM ${message.authorId}
            AND content IS NOT DISTINCT FROM ${message.content}
            AND attachments=${JSON.stringify(message.attachments)}::jsonb
            AND embeds=${JSON.stringify(message.embeds)}::jsonb
            AND stickers=${JSON.stringify(message.stickers)}::jsonb AS exact
          FROM discord_partnership_transcript_messages
          WHERE transcript_id=${transcript.id}::uuid AND message_id=${message.messageId}
        `);
        if (!exact.rows[0]?.exact) throw new PartnershipTicketError(409, "message_conflict", "A transcript message was already stored with different content.");
      }
    }
    await tx.execute(sql`INSERT INTO discord_partnership_transcript_batches (batch_id, transcript_id, payload_sha256) VALUES (${input.batchId}::uuid, ${transcript.id}::uuid, ${payloadSha256})`);
    return { status: "stored" as const, transcriptId: transcript.id, accepted: input.messages.length };
  });
}

export async function finalizePartnershipTranscript(input: { ticketId: string; closeOperationId: string; messageCount: number; contentSha256: string }) {
  return adminDrizzle.transaction(async (tx) => {
    const operation = await tx.execute<{ status: string }>(sql`SELECT status FROM discord_partnership_ticket_operations WHERE id=${input.closeOperationId}::uuid AND ticket_id=${input.ticketId}::uuid AND operation_type='close' FOR UPDATE`);
    if (operation.rows[0]?.status !== "pending") throw new PartnershipTicketError(409, "close_not_pending", "The ticket is not waiting to close.");
    const result = await tx.execute<{ id: string; status: string; message_count: number; content_sha256: string | null }>(sql`SELECT id::text,status,message_count,content_sha256 FROM discord_partnership_transcripts WHERE ticket_id=${input.ticketId}::uuid AND close_operation_id=${input.closeOperationId}::uuid FOR UPDATE`);
    const transcript = result.rows[0];
    if (!transcript) throw new PartnershipTicketError(404, "transcript_not_found", "No transcript has been started for this close operation.");
    if (transcript.status !== "building") {
      if (transcript.message_count === input.messageCount && transcript.content_sha256 === input.contentSha256) return { status: transcript.status, transcriptId: transcript.id };
      throw new PartnershipTicketError(409, "transcript_conflict", "That transcript was finalized differently.");
    }
    const countResult = await tx.execute<{ count: string; first_at: string | null; last_at: string | null }>(sql`SELECT count(*)::text AS count,min(discord_created_at)::text AS first_at,max(discord_created_at)::text AS last_at FROM discord_partnership_transcript_messages WHERE transcript_id=${transcript.id}::uuid`);
    if (Number(countResult.rows[0]!.count) !== input.messageCount) throw new PartnershipTicketError(409, "transcript_incomplete", "The stored transcript message count does not match.");
    await tx.execute(sql`UPDATE discord_partnership_transcripts SET status='finalized', message_count=${input.messageCount}, content_sha256=${input.contentSha256}, first_message_at=${countResult.rows[0]!.first_at}::timestamptz, last_message_at=${countResult.rows[0]!.last_at}::timestamptz, finalized_at=now(), updated_at=now() WHERE id=${transcript.id}::uuid`);
    return { status: "finalized" as const, transcriptId: transcript.id };
  });
}

export async function markPartnershipTranscriptDelivered(input: { ticketId: string; closeOperationId: string; logChannelId: string; logMessageId: string; attachmentId?: string | null; attachmentUrl?: string | null; apiKeyId: string; apiKeyPrefix: string }) {
  return adminDrizzle.transaction(async (tx) => {
    if (input.logChannelId !== PARTNERSHIP_TRANSCRIPT_CHANNEL_ID) throw new PartnershipTicketError(403, "wrong_transcript_channel", "The transcript must be delivered to the configured channel.");
    const operation = await tx.execute<{ status: string }>(sql`SELECT status FROM discord_partnership_ticket_operations WHERE id=${input.closeOperationId}::uuid AND ticket_id=${input.ticketId}::uuid AND operation_type='close' FOR UPDATE`);
    if (operation.rows[0]?.status !== "pending") throw new PartnershipTicketError(409, "close_not_pending", "The ticket is not waiting to close.");
    const result = await tx.execute<{ id: string; status: string; log_message_id: string | null }>(sql`SELECT id::text,status,log_message_id FROM discord_partnership_transcripts WHERE ticket_id=${input.ticketId}::uuid AND close_operation_id=${input.closeOperationId}::uuid FOR UPDATE`);
    const transcript = result.rows[0];
    if (!transcript) throw new PartnershipTicketError(404, "transcript_not_found", "That transcript does not exist.");
    if (transcript.status === "delivered") {
      if (transcript.log_message_id === input.logMessageId) return { status: "delivered" as const, transcriptId: transcript.id };
      throw new PartnershipTicketError(409, "transcript_conflict", "That transcript was delivered as another Discord message.");
    }
    if (transcript.status !== "finalized") throw new PartnershipTicketError(409, "transcript_not_finalized", "The transcript must be finalized before delivery.");
    await tx.execute(sql`UPDATE discord_partnership_transcripts SET status='delivered', log_channel_id=${input.logChannelId}, log_message_id=${input.logMessageId}, attachment_id=${input.attachmentId ?? null}, attachment_url=${input.attachmentUrl ?? null}, delivered_at=now(), updated_at=now() WHERE id=${transcript.id}::uuid`);
    await audit(tx, "discord_partnership_transcript_delivered", { apiKeyId: input.apiKeyId, apiKeyPrefix: input.apiKeyPrefix, ticketId: input.ticketId, transcriptId: transcript.id, logMessageId: input.logMessageId });
    return { status: "delivered" as const, transcriptId: transcript.id };
  });
}

export async function listPartnershipTicketRecovery(input: { guildId: string; limit: number }) {
  const result = await adminDrizzle.execute<TicketRow & {
    operation_id: string | null; operation_type: OperationType | null;
    operation_status: string | null; actor_discord_user_id: string | null;
    transcript_id: string | null; transcript_status: string | null;
    transcript_log_message_id: string | null; transcript_message_count: number | null;
  }>(sql`
    SELECT ticket.id::text, ticket.guild_id, ticket.source_channel_id,
      ticket.applicant_discord_user_id, ticket.applicant_username,
      ticket.applicant_display_name, ticket.submit_interaction_id,
      ticket.social_media_links, ticket.current_past_partner_sites,
      ticket.stats_expectations, ticket.additional_notes, ticket.status,
      ticket.ticket_channel_id, ticket.current_category_id,
      ticket.initial_message_id, ticket.created_at::text, ticket.updated_at::text,
      operation.id::text AS operation_id,
      operation.operation_type, operation.status AS operation_status,
      operation.actor_discord_user_id, transcript.id::text AS transcript_id,
      transcript.status AS transcript_status, transcript.log_message_id AS transcript_log_message_id,
      transcript.message_count AS transcript_message_count
    FROM discord_partnership_tickets AS ticket
    LEFT JOIN LATERAL (
      SELECT * FROM discord_partnership_ticket_operations
      WHERE ticket_id=ticket.id AND status='pending' ORDER BY created_at DESC LIMIT 1
    ) operation ON true
    LEFT JOIN discord_partnership_transcripts transcript ON transcript.ticket_id=ticket.id
    WHERE ticket.guild_id=${input.guildId} AND ticket.status NOT IN ('closed','cancelled')
    ORDER BY ticket.updated_at, ticket.id LIMIT ${input.limit}
  `);
  return { tickets: result.rows.map((row) => ({
    ...publicTicket(row),
    pendingOperation: row.operation_id ? { id: row.operation_id, type: row.operation_type, status: row.operation_status, actorDiscordUserId: row.actor_discord_user_id } : null,
    transcript: row.transcript_id ? { id: row.transcript_id, status: row.transcript_status, logMessageId: row.transcript_log_message_id, messageCount: row.transcript_message_count } : null,
  })) };
}
