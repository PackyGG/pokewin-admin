-- Per-event Telegram notification configuration. One row per event type
-- (deposit / withdrawal / signup). The Vercel cron endpoint reads these
-- rows every minute, fetches new events from the main DB since `cursor`,
-- and forwards them to Telegram using `bot_token` + `chat_id`.
--
-- Rows are seeded up-front so the settings UI has something to render
-- before any admin has touched the page.

CREATE TABLE "notification_configs" (
  "event_type" TEXT PRIMARY KEY,
  "enabled"    BOOLEAN NOT NULL DEFAULT FALSE,
  "bot_token"  TEXT,
  "chat_id"    TEXT,
  "cursor"     TEXT,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by" UUID
);

-- Seed the three known event types so the UI has rows to toggle.
INSERT INTO "notification_configs" ("event_type", "enabled") VALUES
  ('deposit', FALSE),
  ('withdrawal', FALSE),
  ('signup', FALSE)
ON CONFLICT ("event_type") DO NOTHING;
