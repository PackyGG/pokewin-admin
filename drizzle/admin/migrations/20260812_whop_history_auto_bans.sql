-- A dedicated router event for confirmed deterministic automatic bans based
-- on Whop buyer history or a known blacklisted email domain. The #auto-banned channel is
-- provisioned through the existing Discord channel-job worker, then this
-- event is assigned to it through the routing workspace.
INSERT INTO discord_notification_events (
  event_key, label, description, category, is_custom, enabled
)
VALUES (
  'antifraud.account_auto_banned',
  'Account automatically banned',
  'A Packy account was automatically banned by a confirmed deterministic fraud rule.',
  'Accounts',
  false,
  true
)
ON CONFLICT (event_key) DO UPDATE SET
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  category=EXCLUDED.category,
  is_custom=false,
  enabled=true,
  updated_at=now();
