INSERT INTO source_cursors (stream, occurred_at, source_id)
SELECT
  'fiat_suspicious_deposit_clusters_v2',
  now() - interval '7 days',
  ''
WHERE NOT EXISTS (
  SELECT 1
  FROM fiat_email_domain_matches
  WHERE match_type = 'suspicious_deposit_cluster'
)
ON CONFLICT (stream) DO UPDATE SET
  occurred_at = EXCLUDED.occurred_at,
  source_id = EXCLUDED.source_id,
  updated_at = now();
