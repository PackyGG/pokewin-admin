import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("Discord message history is bounded, private, durable, and idempotent", async () => {
  const [route, service, migration, schema, scopes, endpoints] = await Promise.all([
    read("src/app/api/v1/discord/message-events/route.ts"),
    read("src/lib/discord-message-history.ts"),
    read("drizzle/admin/migrations/20260806_discord_message_history.sql"),
    read("src/lib/db-schema/admin/schema.ts"),
    read("src/lib/api-auth/scopes.ts"),
    read("src/lib/api-auth/endpoints.ts"),
  ]);

  assert.match(route, /scopes: \["discord:message-events"\]/);
  assert.match(route, /z\.array\(EventSchema\)\.min\(1\)\.max\(25\)/);
  assert.match(route, /eventId values must be unique within a batch/);
  assert.match(route, /isMessageHistoryGuildAllowed/);
  assert.match(route, /recordDiscordMessageEvents/);
  assert.match(route, /authorIsBot: z\.boolean\(\)\.nullable\(\)/);
  assert.match(route, /webhookId: Snowflake\.nullable\(\)/);
  assert.match(route, /content: z\.string\(\)\.max\(4_000\)\.nullable\(\)/);
  assert.match(route, /attachments: z\.array\(AttachmentSchema\)\.max\(10\)/);

  assert.match(service, /1402743122789929022/);
  assert.match(service, /1505650386894327919/);
  for (const adminId of [
    "660132586630414338",
    "934854938641715240",
    "188051599099297802",
  ]) assert.match(service, new RegExp(adminId));
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /messageIds[\s\S]*\.sort\(\)/);
  assert.match(service, /WHERE event_id = \$\{input\.eventId\}::uuid[\s\S]*FOR UPDATE/);
  assert.match(service, /idempotency_conflict/);
  assert.match(service, /MESSAGE_LOG_EXCLUDED_USER_IDS\.has\(authorId\)/);
  assert.match(service, /authorIsBot === true/);
  assert.match(service, /webhookId !== null/);
  assert.match(service, /discord_message_snapshots/);
  assert.match(service, /discord_message_events/);
  assert.match(service, /before_state/);
  assert.match(service, /after_state/);
  assert.match(service, /snapshot\.deleted_at/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "discord_message_snapshots"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "discord_message_events"/);
  assert.match(migration, /"event_id" uuid PRIMARY KEY/);
  assert.match(migration, /discord_message_events_guild_observed_idx/);
  assert.match(migration, /discord_message_events_author_observed_idx/);
  assert.match(migration, /discord_message_events_message_observed_idx/);
  assert.match(migration, /array_append\("scopes", 'discord:message-events'\)/);
  assert.match(schema, /export const discord_message_snapshots/);
  assert.match(schema, /export const discord_message_events/);
  assert.match(scopes, /"discord:message-events"/);
  assert.match(endpoints, /path: "\/api\/v1\/discord\/message-events"/);
});
