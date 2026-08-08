import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("partnership tickets are guild-pinned, durable, idempotent, and recoverable", async () => {
  const [service, migration, scopes, endpoints, prepare, complete, cancel,
    actionPrepare, actionComplete, actionFail, batch, finalize, delivered, recovery] = await Promise.all([
    read("src/lib/discord-partnership-tickets.ts"),
    read("drizzle/admin/migrations/20260808_discord_partnership_tickets.sql"),
    read("src/lib/api-auth/scopes.ts"), read("src/lib/api-auth/endpoints.ts"),
    read("src/app/api/v1/discord/partnership-tickets/prepare/route.ts"),
    read("src/app/api/v1/discord/partnership-tickets/[ticketId]/complete/route.ts"),
    read("src/app/api/v1/discord/partnership-tickets/[ticketId]/cancel/route.ts"),
    read("src/app/api/v1/discord/partnership-tickets/[ticketId]/actions/prepare/route.ts"),
    read("src/app/api/v1/discord/partnership-tickets/[ticketId]/actions/[operationId]/complete/route.ts"),
    read("src/app/api/v1/discord/partnership-tickets/[ticketId]/actions/[operationId]/fail/route.ts"),
    read("src/app/api/v1/discord/partnership-tickets/[ticketId]/transcript/batch/route.ts"),
    read("src/app/api/v1/discord/partnership-tickets/[ticketId]/transcript/finalize/route.ts"),
    read("src/app/api/v1/discord/partnership-tickets/[ticketId]/transcript/delivered/route.ts"),
    read("src/app/api/v1/discord/partnership-tickets/recovery/route.ts"),
  ]);

  for (const [id, value] of Object.entries({
    PARTNERSHIP_GUILD_ID: "1438216946318442683",
    PARTNERSHIP_PANEL_CHANNEL_ID: "1447322856818999337",
    PARTNERSHIP_OPEN_CATEGORY_ID: "1510419019159834704",
    PARTNERSHIP_OFFERED_CATEGORY_ID: "1496627221689794741",
    PARTNERSHIP_TRANSCRIPT_CHANNEL_ID: "1513275149523091486",
  })) assert.match(service, new RegExp(`${id} = "${value}"`));

  for (const route of [prepare, complete, cancel, actionPrepare, actionComplete,
    actionFail, batch, finalize, delivered, recovery]) {
    assert.match(route, /scopes:\s*\["discord:partnership-tickets"\]/);
    assert.match(route, /\.strict\(\)/);
  }
  assert.match(scopes, /"discord:partnership-tickets"/);
  assert.match(endpoints, /partnership-tickets\/prepare/);
  assert.match(endpoints, /partnership-tickets\/recovery/);
  assert.match(prepare, /z\.literal\(PARTNERSHIP_PANEL_CHANNEL_ID\)/);
  assert.match(complete, /z\.literal\(PARTNERSHIP_OPEN_CATEGORY_ID\)/);
  assert.match(delivered, /z\.literal\(PARTNERSHIP_TRANSCRIPT_CHANNEL_ID\)/);

  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /idempotency_conflict/);
  assert.match(service, /status NOT IN \('closed', 'cancelled'\)/);
  assert.match(service, /transcript_not_delivered/);
  assert.match(service, /observedChannelDeleted !== true/);
  assert.match(service, /payloadSha256/);
  assert.match(service, /message_conflict/);
  assert.match(service, /listPartnershipTicketRecovery/);
  assert.match(service, /publicOperation/);
  assert.doesNotMatch(service, /getProdRead|getProdWrite|DATABASE_URL/);

  assert.match(migration, /ADMIN database only/);
  assert.match(migration, /discord_partnership_tickets_one_active_applicant/);
  assert.match(migration, /WHERE status NOT IN \('closed', 'cancelled'\)/);
  assert.match(migration, /discord_partnership_ticket_operations_one_pending/);
  assert.match(migration, /discord_partnership_transcript_batches/);
  assert.match(migration, /discord_partnership_transcript_messages/);
  assert.match(migration, /ON DELETE RESTRICT/);
  assert.match(migration, /jsonb_array_length\(attachments\) <= 10/);
});
