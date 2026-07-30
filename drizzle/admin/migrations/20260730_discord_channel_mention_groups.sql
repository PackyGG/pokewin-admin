-- Per-channel Discord mention groups.
--
-- Before this table the tag list was decided by the ALERT PRODUCER in code:
-- support was mentioned on every signup/rule alert, owner+managers were added
-- when the producer marked an alert urgent, and channels had no say at all.
-- Operators could not change who a channel tags without a deploy.
--
-- Now each routed channel selects the groups it tags. The group -> Discord user
-- id membership stays pinned in `src/lib/discord-notifications/antifraud-policy.ts`
-- (ANTIFRAUD_TEAM_IDS) so the ids remain a reviewed code fact; only the
-- SELECTION is operator data. Urgent escalation still adds its groups on top of
-- whatever a channel selects, so a paged incident cannot be silenced by
-- misconfiguring one channel.
--
-- Configuration belongs to the ADMIN database. The MAIN game/customer database
-- is not involved.

CREATE TABLE IF NOT EXISTS "discord_notification_channel_mentions" (
  "guild_id" TEXT NOT NULL,
  "channel_id" TEXT NOT NULL,
  "group_key" TEXT NOT NULL,
  "created_by" UUID REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "discord_notification_channel_mentions_pkey"
    PRIMARY KEY ("guild_id", "channel_id", "group_key"),
  -- Mirrors ANTIFRAUD_TEAM_IDS. Adding a group means editing both, which is
  -- deliberate: an unknown key must never silently resolve to zero mentions.
  CONSTRAINT "discord_notification_channel_mentions_group_check"
    CHECK ("group_key" IN ('owner', 'managers', 'dev', 'support')),
  CONSTRAINT "discord_notification_channel_mentions_channel_fk"
    FOREIGN KEY ("guild_id", "channel_id")
    REFERENCES "discord_notification_channels"("guild_id", "channel_id")
    ON DELETE CASCADE
);

-- The resolve path reads every selected group for one channel.
CREATE INDEX IF NOT EXISTS "discord_notification_channel_mentions_channel_idx"
  ON "discord_notification_channel_mentions" ("guild_id", "channel_id");

-- Carry the mention allowlist with the job.
--
-- `buildDiscordAlertPayload` used to build `allowed_mentions` and then throw it
-- away: `sendBotDiscordEvent` forwarded only embed/components/content, the
-- ingest schema had no such field, and this table had no column for it. The
-- restriction therefore never reached Discord. The queue now resolves the
-- mention set itself and stores the matching allowlist next to the content, so
-- the delivering bot can pin `allowed_mentions` to exactly these ids instead of
-- letting Discord parse whatever the message text happens to contain.
ALTER TABLE "discord_notification_jobs"
  ADD COLUMN IF NOT EXISTS "allowed_mentions" JSONB;

-- Seed the exact behaviour that is live today, so applying this migration
-- changes nothing until an operator edits a channel:
--   * every channel that already carries a route tags `support`;
--   * channels under the Errors (1532216500444856360) and KYC
--     (1532297417339174922) categories tag nobody -- those are the silent
--     categories whose mention content `enqueueDiscordEvent` already drops.
-- The category ids are inlined rather than referenced because a migration is a
-- point-in-time record; SILENT_DISCORD_CATEGORY_IDS is the live source.
INSERT INTO "discord_notification_channel_mentions" (
  "guild_id", "channel_id", "group_key"
)
SELECT DISTINCT
  route."guild_id",
  route."channel_id",
  'support'
FROM "discord_notification_routes" AS route
JOIN "discord_notification_channels" AS channel
  ON channel."guild_id" = route."guild_id"
 AND channel."channel_id" = route."channel_id"
WHERE channel."parent_id" IS NOT NULL
  AND channel."parent_id" NOT IN (
    '1532216500444856360',
    '1532297417339174922'
  )
ON CONFLICT DO NOTHING;
