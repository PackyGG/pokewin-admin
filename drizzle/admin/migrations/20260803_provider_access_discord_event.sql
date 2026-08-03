-- Dedicated Discord routing action for third-party credential and credit
-- exhaustion. This is intentionally separate from the broad provider-error
-- feed so operators can route actionable account/configuration failures to a
-- different Errors channel.

INSERT INTO discord_notification_events
  (event_key, label, description, category, is_custom, enabled)
VALUES
  (
    'antifraud.error.provider_access',
    'Third-party API key or credits',
    'A provider key is missing or invalid, or its paid query balance is exhausted or running low.',
    'Errors',
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
