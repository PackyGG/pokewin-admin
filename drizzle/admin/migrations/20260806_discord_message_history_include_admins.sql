-- Human admins are now audited like every other user. Old admin snapshots were
-- deliberately redacted and contain no usable baseline, so remove only those
-- marker rows and let the bot establish a fresh snapshot on the next event.
DELETE FROM "discord_message_snapshots" AS snapshot
WHERE
  snapshot."excluded_from_logging" IS TRUE
  AND snapshot."author_is_bot" IS NOT TRUE
  AND snapshot."webhook_id" IS NULL
  AND snapshot."author_id" IN (
    '660132586630414338',
    '934854938641715240',
    '188051599099297802'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "discord_message_events" AS event
    WHERE event."message_id" = snapshot."message_id"
  );
