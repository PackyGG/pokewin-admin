-- A paid Fiat deposit that was withheld from automatic credit is an actionable
-- money decision, not a routine payment-lifecycle warning. Give it a dedicated
-- event so the Deposits channel receives only rows that need a staff verdict.

INSERT INTO discord_notification_events
  (event_key, label, description, category, is_custom, enabled)
VALUES
  (
    'antifraud.fiat_credit_review_required',
    'Fiat deposit needs credit review',
    'A paid Fiat deposit was not credited automatically and needs a staff approve or decline decision.',
    'Fiat',
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

-- Route the action to #deposits in the approved Transactions category. The
-- guarded SELECT keeps fresh/dev environments safe when this production
-- Discord channel has not been synced there.
INSERT INTO discord_notification_routes
  (guild_id, event_key, channel_id, enabled)
SELECT
  channel.guild_id,
  'antifraud.fiat_credit_review_required',
  channel.channel_id,
  true
FROM discord_notification_channels AS channel
WHERE channel.guild_id = '1483064422778798112'
  AND channel.channel_id = '1535849236447625266'
  AND channel.parent_id = '1532207461077876766'
  AND channel.available = true
  AND channel.can_view = true
  AND channel.can_send = true
  AND channel.can_embed = true
ON CONFLICT (guild_id, event_key, channel_id) DO UPDATE SET
  enabled = true,
  updated_at = now();

-- This action has one production destination. Remove stale manual routes so a
-- review cannot notify unrelated channels as well as #deposits.
DELETE FROM discord_notification_routes
WHERE guild_id = '1483064422778798112'
  AND event_key = 'antifraud.fiat_credit_review_required'
  AND channel_id <> '1535849236447625266';
