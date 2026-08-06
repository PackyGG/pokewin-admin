CREATE TABLE IF NOT EXISTS "discord_message_snapshots" (
  "message_id" text PRIMARY KEY NOT NULL,
  "guild_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "author_id" text,
  "author_username" text,
  "author_display_name" text,
  "author_is_bot" boolean,
  "webhook_id" text,
  "content" text,
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "referenced_message_id" text,
  "discord_created_at" timestamptz,
  "discord_edited_at" timestamptz,
  "deleted_at" timestamptz,
  "first_observed_at" timestamptz NOT NULL,
  "last_observed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "discord_message_snapshots_guild_id_check"
    CHECK ("guild_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_snapshots_channel_id_check"
    CHECK ("channel_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_snapshots_message_id_check"
    CHECK ("message_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_snapshots_author_id_check"
    CHECK ("author_id" IS NULL OR "author_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_snapshots_webhook_id_check"
    CHECK ("webhook_id" IS NULL OR "webhook_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_snapshots_reference_id_check"
    CHECK ("referenced_message_id" IS NULL OR "referenced_message_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_snapshots_username_length_check"
    CHECK ("author_username" IS NULL OR char_length("author_username") <= 100),
  CONSTRAINT "discord_message_snapshots_display_name_length_check"
    CHECK ("author_display_name" IS NULL OR char_length("author_display_name") <= 100),
  CONSTRAINT "discord_message_snapshots_content_length_check"
    CHECK ("content" IS NULL OR char_length("content") <= 4000),
  CONSTRAINT "discord_message_snapshots_attachments_array_check"
    CHECK (jsonb_typeof("attachments") = 'array')
);

CREATE INDEX IF NOT EXISTS "discord_message_snapshots_guild_observed_idx"
  ON "discord_message_snapshots" ("guild_id", "last_observed_at" DESC);

CREATE INDEX IF NOT EXISTS "discord_message_snapshots_author_observed_idx"
  ON "discord_message_snapshots" ("author_id", "last_observed_at" DESC)
  WHERE "author_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "discord_message_snapshots_channel_observed_idx"
  ON "discord_message_snapshots" ("guild_id", "channel_id", "last_observed_at" DESC);

CREATE TABLE IF NOT EXISTS "discord_message_events" (
  "event_id" uuid PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "message_id" text NOT NULL,
  "guild_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "author_id" text,
  "author_username" text,
  "author_display_name" text,
  "before_state" jsonb NOT NULL,
  "after_state" jsonb,
  "discord_created_at" timestamptz,
  "observed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "discord_message_events_type_check"
    CHECK ("event_type" IN ('create', 'update', 'delete')),
  CONSTRAINT "discord_message_events_guild_id_check"
    CHECK ("guild_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_events_channel_id_check"
    CHECK ("channel_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_events_message_id_check"
    CHECK ("message_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_events_author_id_check"
    CHECK ("author_id" IS NULL OR "author_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_message_events_before_object_check"
    CHECK (jsonb_typeof("before_state") = 'object'),
  CONSTRAINT "discord_message_events_after_object_check"
    CHECK ("after_state" IS NULL OR jsonb_typeof("after_state") = 'object')
);

CREATE INDEX IF NOT EXISTS "discord_message_events_guild_observed_idx"
  ON "discord_message_events" ("guild_id", "observed_at" DESC);

CREATE INDEX IF NOT EXISTS "discord_message_events_author_observed_idx"
  ON "discord_message_events" ("author_id", "observed_at" DESC)
  WHERE "author_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "discord_message_events_message_observed_idx"
  ON "discord_message_events" ("message_id", "observed_at");

-- Grant only the deployed Rewards Bot key the narrow write capability. The
-- prefix is a public identifier and is not credential material.
UPDATE "api_keys"
SET "scopes" = array_append("scopes", 'discord:message-events')
WHERE "prefix" = 'pwa__WZ4VvUngxA4'
  AND "is_active" = true
  AND NOT ('discord:message-events' = ANY("scopes"));
