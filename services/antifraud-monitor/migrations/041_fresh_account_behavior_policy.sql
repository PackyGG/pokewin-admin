-- Additive fresh-account behavior policy. MAIN remains a read-only source;
-- durable evidence, idempotency, scoring, and delivery state stay here.

INSERT INTO score_weights(key, points, updated_by)
VALUES
  ('risky_location', 15, 'system:fresh-account-behavior-v1'),
  ('crypto_deposit', -20, 'system:fresh-account-behavior-v1'),
  ('fiat_deposit', -5, 'system:fresh-account-behavior-v1'),
  ('paid_pack_opened', -3, 'system:fresh-account-behavior-v1'),
  ('ledger_battle_bet', -3, 'system:fresh-account-behavior-v1'),
  ('ledger_battle_sponsorship', -3, 'system:fresh-account-behavior-v1'),
  ('ledger_upgrader_bet', -3, 'system:fresh-account-behavior-v1'),
  ('session_hopping', 50, 'system:fresh-account-behavior-v1'),
  ('dormant_device_switch', 60, 'system:fresh-account-behavior-v1')
ON CONFLICT (key) DO UPDATE
SET points = EXCLUDED.points,
    updated_by = EXCLUDED.updated_by,
    updated_at = now();

UPDATE score_weights
SET points = CASE key
      WHEN 'fingerprint_proxy' THEN 55
      WHEN 'fingerprint_datacenter' THEN 35
      WHEN 'abstract_ip_proxy' THEN 55
      WHEN 'abstract_ip_hosting' THEN 35
      ELSE points
    END,
    updated_by = 'system:fresh-account-behavior-v1',
    updated_at = now()
WHERE key IN (
  'fingerprint_proxy',
  'fingerprint_datacenter',
  'abstract_ip_proxy',
  'abstract_ip_hosting'
);

UPDATE rule_definitions
SET score_delta = 70,
    action_type = 'manual_review',
    description = CASE key
      WHEN 'tip-before-deposit'
        THEN 'A normal fresh account receives a creator tip before depositing. Linked creator site-role accounts are exempt.'
      ELSE 'A normal fresh account joins a sponsored battle before depositing. Linked creator site-role accounts are exempt.'
    END,
    updated_at = now()
WHERE key IN ('tip-before-deposit','sponsored-battle-before-deposit');

INSERT INTO rule_definitions (
  key, name, description, enabled, trigger, sequence, exclude_before,
  window_seconds, score_delta, action_type, priority
)
VALUES
  (
    'fresh-third-promo-redemption',
    'Third promo redemption on fresh account',
    'A fresh account redeems a third promotion before the monitoring window ends.',
    true,
    'sequence',
    '["ledger_promo_code_redeemed","ledger_promo_code_redeemed","ledger_promo_code_redeemed"]'::jsonb,
    '[]'::jsonb,
    900,
    100,
    'lock_withdrawals',
    8
  ),
  (
    'fresh-minimum-withdrawal-runup',
    'Quick reward run-up to minimum withdrawal',
    'Reward-derived value reaches the minimum withdrawal level before any completed deposit.',
    true,
    'sequence',
    '["minimum_withdrawal_runup"]'::jsonb,
    '["fiat_deposit","crypto_deposit"]'::jsonb,
    900,
    55,
    'manual_review',
    9
  )
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    enabled = EXCLUDED.enabled,
    trigger = EXCLUDED.trigger,
    sequence = EXCLUDED.sequence,
    exclude_before = EXCLUDED.exclude_before,
    window_seconds = EXCLUDED.window_seconds,
    score_delta = EXCLUDED.score_delta,
    action_type = EXCLUDED.action_type,
    priority = EXCLUDED.priority,
    updated_at = now();
