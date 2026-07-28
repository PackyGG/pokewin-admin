UPDATE source_cursors
SET
  occurred_at = now() - interval '7 days',
  source_id = '',
  updated_at = now()
WHERE stream = 'fiat_suspicious_deposit_clusters'
  AND NOT EXISTS (
    SELECT 1
    FROM fiat_email_domain_matches
    WHERE match_type = 'suspicious_deposit_cluster'
  );
