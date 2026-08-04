-- Consolidate operational errors into the four surviving PackyGG Work Server
-- channels. Historical jobs and event rows are retained for auditability.

INSERT INTO discord_notification_events
  (event_key, label, description, category, is_custom, enabled)
VALUES
  (
    'antifraud.error.webapp',
    'Webapp error',
    'Admin, Marketing, Packs, or Fraud webapp and code errors. Alerts identify the webapp and runtime server.',
    'Errors', false, true
  ),
  (
    'antifraud.error.third_party_api',
    'Third-party API error',
    'Missing, invalid, expired, rejected, exhausted, timed-out, malformed, or unexpected provider API failures.',
    'Errors', false, true
  ),
  (
    'antifraud.error.discord_command',
    'Discord, bot, or command error',
    'Discord server, bot, delivery, interaction, and command failures, including Discord timeouts.',
    'Errors', false, true
  ),
  (
    'antifraud.error.general',
    'General uncategorized error',
    'Operational failures that do not belong to Webapp, Third-party API, or Discord.',
    'Errors', false, true
  )
ON CONFLICT (event_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  is_custom = false,
  enabled = true,
  updated_at = now();

UPDATE discord_notification_events
SET enabled = false, updated_at = now()
WHERE event_key IN (
  'antifraud.error.code',
  'antifraud.error.failed_action',
  'antifraud.error.provider_access',
  'antifraud.error.system',
  'antifraud.error.timeout'
);

DELETE FROM discord_notification_routes
WHERE guild_id = '1483064422778798112'
  AND event_key LIKE 'antifraud.error.%';

INSERT INTO discord_notification_routes (
  guild_id, event_key, channel_id, enabled
)
SELECT
  '1483064422778798112', desired.event_key, desired.channel_id, true
FROM (
  VALUES
    ('antifraud.error.webapp', '1532248855133945956'),
    ('antifraud.error.third_party_api', '1532249079999103077'),
    ('antifraud.error.discord_command', '1532248846103613552'),
    ('antifraud.error.general', '1532248582525157458')
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
  SELECT count(*)::integer
  INTO route_count
  FROM discord_notification_routes
  WHERE guild_id = '1483064422778798112'
    AND enabled = true
    AND (event_key, channel_id) IN (
      ('antifraud.error.webapp', '1532248855133945956'),
      ('antifraud.error.third_party_api', '1532249079999103077'),
      ('antifraud.error.discord_command', '1532248846103613552'),
      ('antifraud.error.general', '1532248582525157458')
    );
  IF route_count <> 4 THEN
    RAISE EXCEPTION 'Expected four live error routes, found %', route_count;
  END IF;
END $$;
