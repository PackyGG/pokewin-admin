INSERT INTO fiat_deposit_access_policies
  (scope, generation, enabled, effective_at, actor_id)
SELECT
  'new_signups',
  COALESCE(MAX(generation), 0) + 1,
  false,
  now(),
  'system:default-new-signup-policy'
FROM fiat_deposit_access_policies
WHERE scope = 'new_signups'
HAVING COUNT(*) = 0;

INSERT INTO fiat_deposit_access_cursors(stream, occurred_at, source_id)
SELECT 'new_signups', effective_at, ''
FROM fiat_deposit_access_policies
WHERE scope = 'new_signups'
ORDER BY generation DESC
LIMIT 1
ON CONFLICT (stream) DO UPDATE
SET occurred_at = EXCLUDED.occurred_at,
    source_id = EXCLUDED.source_id;
