-- High-risk and critical-risk signup alerts now open Account Review directly,
-- so the old generic need-review Discord post is duplicate noise. Preserve the
-- event row for audit/history and leave every reminder, lock, KYC, and other
-- non-signup Account Review route untouched.

DELETE FROM discord_notification_routes
WHERE guild_id = '1483064422778798112'
  AND channel_id = '1532248557740884039'
  AND event_key = 'antifraud.review_opened';

UPDATE discord_notification_events
SET
  label = 'Legacy account review opened',
  description = 'Retired duplicate signup review action. High-risk and critical-risk signup alerts link directly to Account Review.',
  enabled = false,
  updated_at = now()
WHERE event_key = 'antifraud.review_opened';
