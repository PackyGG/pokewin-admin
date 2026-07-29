UPDATE score_weights
SET points = 20,
    updated_at = now()
WHERE key = 'risky_location'
  AND points = 40;
