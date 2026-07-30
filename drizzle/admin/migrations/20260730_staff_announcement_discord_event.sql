-- Staff announcements move off the raw ANTIFRAUD_DISCORD_WEBHOOK_URL channel
-- webhook and onto the Discord bot delivery queue, like every other alert.
--
-- No route is created here: delivery stays off until a manager assigns this
-- event to a channel on Fraud → Discord Routing. That is deliberate — a seeded
-- route would start posting staff pings into a channel nobody chose.

INSERT INTO discord_notification_events
  (event_key, label, description, category, is_custom, enabled)
VALUES
  (
    'staff.announcement',
    'Staff announcement',
    'An owner or admin sent an announcement to dashboard staff.',
    'Staff',
    false,
    true
  )
ON CONFLICT (event_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  is_custom = false,
  updated_at = now();
