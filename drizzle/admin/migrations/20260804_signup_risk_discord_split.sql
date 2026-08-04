-- Split the old combined 50+ signup action into explicit high and critical
-- actions. Historical jobs keep the retired catalog row for auditability.

INSERT INTO discord_notification_events
  (event_key, label, description, category, is_custom, enabled)
VALUES
  (
    'antifraud.signup_high',
    'High-risk signup',
    'A signup scored 50-69, entered a 10-minute monitor, and opened Account Review.',
    'Signups',
    false,
    true
  ),
  (
    'antifraud.signup_critical',
    'Critical-risk signup',
    'A signup scored 70-100, entered a 15-minute monitor, opened Account Review, and automatically locked Fiat deposits, withdrawals, and tips.',
    'Signups',
    false,
    true
  )
ON CONFLICT (event_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  is_custom = false,
  enabled = true,
  updated_at = now();

UPDATE discord_notification_events
SET
  label = 'Low-risk signup',
  description = 'A signup scored 21-49 and entered a 5-minute monitor without staff review or automatic restrictions.',
  enabled = true,
  updated_at = now()
WHERE event_key = 'antifraud.signup_low_risk';

-- The old action covered every score from 50 through 100. Remove its live
-- routing and disable it, while retaining the row referenced by delivered jobs.
DELETE FROM discord_notification_routes
WHERE event_key = 'antifraud.signup_high_risk';

-- Route the two replacement actions to their dedicated synced channels in the
-- PackyGG Accounts category. The INSERT ... SELECT keeps the migration safe if
-- a fresh environment does not have those production Discord channels.
INSERT INTO discord_notification_routes
  (guild_id, event_key, channel_id, enabled)
SELECT
  channel.guild_id,
  route.event_key,
  channel.channel_id,
  true
FROM (
  VALUES
    ('antifraud.signup_high', '1534296433241493774'),
    ('antifraud.signup_critical', '1534296454129254523')
) AS route(event_key, channel_id)
JOIN discord_notification_channels AS channel
  ON channel.guild_id = '1483064422778798112'
 AND channel.channel_id = route.channel_id
 AND channel.parent_id = '1532207307683795026'
 AND channel.available = true
ON CONFLICT (guild_id, event_key, channel_id) DO UPDATE SET
  enabled = true,
  updated_at = now();

-- Each replacement action owns exactly one live route in the production guild.
DELETE FROM discord_notification_routes
WHERE guild_id = '1483064422778798112'
  AND event_key = 'antifraud.signup_high'
  AND channel_id <> '1534296433241493774';

DELETE FROM discord_notification_routes
WHERE guild_id = '1483064422778798112'
  AND event_key = 'antifraud.signup_critical'
  AND channel_id <> '1534296454129254523';

UPDATE discord_notification_events
SET
  label = 'Legacy combined signup risk',
  description = 'Retired combined 50-100 signup action. Replaced by separate high-risk and critical-risk actions.',
  enabled = false,
  updated_at = now()
WHERE event_key = 'antifraud.signup_high_risk';
