-- The #deposits channel carries the actionable Fiat credit-review event.
-- Tag Support on every delivery to this exact production channel so the
-- people who can work the queue see it promptly. The guarded SELECT keeps
-- non-production environments and stale channel syncs unchanged.

INSERT INTO discord_notification_channel_mentions (
  guild_id,
  channel_id,
  group_key,
  created_by
)
SELECT
  channel.guild_id,
  channel.channel_id,
  'support',
  NULL
FROM discord_notification_channels AS channel
WHERE channel.guild_id = '1483064422778798112'
  AND channel.channel_id = '1535849236447625266'
  AND channel.name = 'deposits'
  AND channel.parent_id = '1532207461077876766'
  AND channel.available = true
  AND EXISTS (
    SELECT 1
    FROM discord_notification_routes AS route
    WHERE route.guild_id = channel.guild_id
      AND route.channel_id = channel.channel_id
      AND route.event_key = 'antifraud.fiat_credit_review_required'
      AND route.enabled = true
  )
ON CONFLICT (guild_id, channel_id, group_key) DO NOTHING;
