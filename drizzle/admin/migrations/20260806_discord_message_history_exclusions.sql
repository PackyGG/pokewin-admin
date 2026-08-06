ALTER TABLE "discord_message_snapshots"
  ADD COLUMN IF NOT EXISTS "excluded_from_logging" boolean NOT NULL DEFAULT false;

UPDATE "discord_message_snapshots"
SET
  "excluded_from_logging" = true,
  "content" = NULL,
  "attachments" = '[]'::jsonb,
  "referenced_message_id" = NULL,
  "updated_at" = now()
WHERE
  "author_is_bot" IS TRUE
  OR "webhook_id" IS NOT NULL
  OR "author_id" IN (
    '660132586630414338',
    '934854938641715240',
    '188051599099297802'
  );
