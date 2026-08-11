-- Retire noisy/unused notification types and route the remaining operational
-- events to their dedicated Discord channels.

UPDATE discord_notification_events
SET enabled = false, updated_at = now()
WHERE event_key IN (
  'antifraud.account_banned',
  'antifraud.signup_low_risk'
);

UPDATE discord_notification_events
SET enabled = true, updated_at = now()
WHERE event_key IN (
  'antifraud.error.discord_command',
  'antifraud.error.general',
  'antifraud.kyc_required'
);

DELETE FROM discord_notification_routes
WHERE guild_id = '1483064422778798112'
  AND event_key IN (
    'antifraud.account_banned',
    'antifraud.signup_low_risk',
    'antifraud.error.discord_command',
    'antifraud.error.general',
    'antifraud.kyc_required'
  );

INSERT INTO discord_notification_routes (guild_id, event_key, channel_id, enabled)
SELECT '1483064422778798112', desired.event_key, desired.channel_id, true
FROM (
  VALUES
    ('antifraud.error.discord_command', '1536858616810704957'),
    ('antifraud.error.general', '1536858608132690040'),
    ('antifraud.kyc_required', '1532298371052867634')
) AS desired(event_key, channel_id)
JOIN discord_notification_events AS event
  ON event.event_key = desired.event_key
 AND event.enabled = true
JOIN discord_notification_channels AS channel
  ON channel.guild_id = '1483064422778798112'
 AND channel.channel_id = desired.channel_id
 AND channel.available = true
 AND channel.can_view = true
 AND channel.can_send = true
 AND channel.can_embed = true;

DO $$
DECLARE
  route_count integer;
BEGIN
  SELECT count(*)::integer INTO route_count
  FROM discord_notification_routes
  WHERE guild_id = '1483064422778798112'
    AND enabled = true
    AND (event_key, channel_id) IN (
      ('antifraud.error.discord_command', '1536858616810704957'),
      ('antifraud.error.general', '1536858608132690040'),
      ('antifraud.kyc_required', '1532298371052867634')
    );
  IF route_count <> 3 THEN
    RAISE EXCEPTION 'Expected three dedicated Discord routes, found %', route_count;
  END IF;
END $$;
