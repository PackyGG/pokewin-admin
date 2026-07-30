-- Discord routing event for "the player actually opened the Sumsub flow".
-- Seeded disabled-for-nobody: the event exists so staff can attach it to an
-- approved channel, but no route is created here — delivery stays opt-in.

INSERT INTO discord_notification_events
  (event_key, label, description, category, is_custom, enabled)
VALUES
  (
    'antifraud.sumsub_started',
    'Sumsub verification started',
    'A player opened the Sumsub flow and an applicant was created.',
    'Accounts',
    false,
    true
  )
ON CONFLICT (event_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  is_custom = false,
  updated_at = now();
