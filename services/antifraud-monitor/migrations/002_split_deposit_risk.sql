UPDATE rule_definitions
SET exclude_before = '["fiat_deposit","crypto_deposit","deposit_unclassified"]'::jsonb,
    updated_at = now()
WHERE key IN ('reward-rush', 'reward-before-deposit')
  AND exclude_before = '["deposit"]'::jsonb;
