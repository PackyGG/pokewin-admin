-- Configurable Discord action for monitored signups scoring 21–49.

INSERT INTO discord_notification_events
  (event_key, label, description, category, is_custom, enabled)
VALUES
  (
    'antifraud.signup_low_risk',
    'Low-risk signup',
    'A signup scored 21–49 and entered the 7.5-minute monitoring window without opening staff review.',
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
