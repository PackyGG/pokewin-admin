CREATE TABLE IF NOT EXISTS kyc_notification_cursors (
  stream TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  tie_breaker TEXT NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT kyc_notification_cursors_stream_check
    CHECK (stream IN ('kyc_required', 'sumsub_started', 'sumsub_ready'))
);

UPDATE discord_notification_events
SET enabled = true, updated_at = now()
WHERE event_key IN (
  'antifraud.kyc_required',
  'antifraud.sumsub_started',
  'antifraud.sumsub_ready'
);

INSERT INTO discord_notification_routes (guild_id, event_key, channel_id, enabled)
SELECT '1483064422778798112', event.event_key, '1532298371052867634', true
FROM discord_notification_events AS event
JOIN discord_notification_channels AS channel
  ON channel.guild_id = '1483064422778798112'
 AND channel.channel_id = '1532298371052867634'
 AND channel.available = true
 AND channel.can_view = true
 AND channel.can_send = true
 AND channel.can_embed = true
WHERE event.event_key IN (
  'antifraud.kyc_required',
  'antifraud.sumsub_started',
  'antifraud.sumsub_ready'
)
ON CONFLICT (guild_id, event_key, channel_id) DO UPDATE SET
  enabled = true,
  updated_at = now();

DO $$
DECLARE route_count integer;
BEGIN
  SELECT count(*)::integer INTO route_count
  FROM discord_notification_routes
  WHERE guild_id = '1483064422778798112'
    AND channel_id = '1532298371052867634'
    AND enabled = true
    AND event_key IN (
      'antifraud.kyc_required',
      'antifraud.sumsub_started',
      'antifraud.sumsub_ready'
    );
  IF route_count <> 3 THEN
    RAISE EXCEPTION 'Expected three KYC lifecycle routes, found %', route_count;
  END IF;
END $$;
