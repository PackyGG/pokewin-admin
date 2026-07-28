INSERT INTO score_weights(key, points, updated_by)
VALUES
  ('ip_velocity_10m', 60, 'system:signup-live-behavior-tuning'),
  ('generated_username', 25, 'system:signup-live-behavior-tuning'),
  ('country_cluster_ten_plus', 25, 'system:signup-live-behavior-tuning'),
  ('country_cluster_twenty_five_plus', 50, 'system:signup-live-behavior-tuning'),
  ('proxycheck_risk_medium', 40, 'system:signup-live-behavior-tuning'),
  ('proxycheck_risk_high', 80, 'system:signup-live-behavior-tuning'),
  ('ledger_battle_bet', -5, 'system:signup-live-behavior-tuning'),
  ('ledger_battle_sponsorship', -5, 'system:signup-live-behavior-tuning'),
  ('ledger_upgrader_bet', -5, 'system:signup-live-behavior-tuning'),
  ('welcome_reward_opened', 0, 'system:signup-live-behavior-tuning'),
  ('level_one_reward_opened', 0, 'system:signup-live-behavior-tuning'),
  ('daily_reward_opened', -10, 'system:signup-live-behavior-tuning'),
  ('ledger_deposit_bonus', -10, 'system:signup-live-behavior-tuning'),
  ('ledger_rakeback_claim', -10, 'system:signup-live-behavior-tuning'),
  ('ledger_rain_win', 0, 'system:signup-live-behavior-tuning'),
  ('ledger_race_prize', -10, 'system:signup-live-behavior-tuning'),
  ('ledger_affiliate_leaderboard_prize', -10, 'system:signup-live-behavior-tuning'),
  ('ledger_challenge_prize', -10, 'system:signup-live-behavior-tuning'),
  ('ledger_creator_tip', 0, 'system:signup-live-behavior-tuning'),
  ('creator_sponsored_battle_received', 0, 'system:signup-live-behavior-tuning')
ON CONFLICT (key) DO UPDATE
SET points = EXCLUDED.points,
    updated_by = EXCLUDED.updated_by,
    updated_at = now();

DELETE FROM score_weights
WHERE key IN (
  'missing_email',
  'deposit_unclassified',
  'reward_opened',
  'bonus_received'
);

UPDATE rule_definitions
SET enabled = false,
    description = description || ' Retired: replaced by reward-specific live behavior.',
    updated_at = now()
WHERE enabled = true
  AND (
    key IN ('reward-rush', 'reward-before-deposit', 'signup-bonus-stack')
    OR sequence ?| ARRAY[
      'reward_opened',
      'bonus_received',
      'deposit_unclassified'
    ]
    OR exclude_before ?| ARRAY['deposit_unclassified']
  );

INSERT INTO rule_definitions
  (key, name, description, enabled, trigger, sequence, exclude_before,
   window_seconds, score_delta, action_type, priority)
VALUES
  (
    'welcome-paid-pack-rush',
    'Welcome reward into paid pack',
    'The account opens all three welcome packs and immediately uses the proceeds on a paid pack before depositing.',
    true,
    'sequence',
    '["welcome_reward_opened","paid_pack_opened"]'::jsonb,
    '["fiat_deposit","crypto_deposit"]'::jsonb,
    180,
    35,
    'manual_review',
    10
  ),
  (
    'welcome-battle-rush',
    'Welcome reward into battle',
    'The account opens all three welcome packs and immediately enters a battle before depositing.',
    true,
    'sequence',
    '["welcome_reward_opened","ledger_battle_bet"]'::jsonb,
    '["fiat_deposit","crypto_deposit"]'::jsonb,
    180,
    35,
    'manual_review',
    11
  ),
  (
    'welcome-upgrader-rush',
    'Welcome reward into upgrader',
    'The account opens all three welcome packs and immediately places an upgrader bet before depositing.',
    true,
    'sequence',
    '["welcome_reward_opened","ledger_upgrader_bet"]'::jsonb,
    '["fiat_deposit","crypto_deposit"]'::jsonb,
    180,
    35,
    'manual_review',
    12
  ),
  (
    'welcome-level-one-stack',
    'Welcome plus Level 1 daily pack',
    'The account opens the three-pack welcome reward and the level-0-unlocked Level 1 daily pack before depositing.',
    true,
    'sequence',
    '["welcome_reward_opened","level_one_reward_opened"]'::jsonb,
    '["fiat_deposit","crypto_deposit"]'::jsonb,
    180,
    35,
    'manual_review',
    13
  ),
  (
    'tip-before-deposit',
    'Tip received before deposit',
    'A new account receives a creator-funded tip before making any deposit.',
    true,
    'sequence',
    '["ledger_creator_tip"]'::jsonb,
    '["fiat_deposit","crypto_deposit"]'::jsonb,
    180,
    40,
    'manual_review',
    14
  ),
  (
    'sponsored-battle-before-deposit',
    'Sponsored battle before deposit',
    'A new account joins a site- or creator-sponsored battle before making any deposit.',
    true,
    'sequence',
    '["creator_sponsored_battle_received"]'::jsonb,
    '["fiat_deposit","crypto_deposit"]'::jsonb,
    180,
    40,
    'manual_review',
    15
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
