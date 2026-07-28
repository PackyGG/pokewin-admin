ALTER TABLE fiat_email_domain_matches
  DROP CONSTRAINT IF EXISTS fiat_email_domain_matches_match_type_check;

ALTER TABLE fiat_email_domain_matches
  ADD CONSTRAINT fiat_email_domain_matches_match_type_check
  CHECK (
    match_type IN (
      'blacklisted_domain',
      'gmail_dot_fragmentation',
      'suspicious_deposit_cluster'
    )
  );

CREATE INDEX IF NOT EXISTS fiat_problem_alert_outbox_cluster_dedupe_idx
  ON fiat_problem_alert_outbox (
    problem_code,
    occurred_at DESC
  )
  WHERE problem_code = 'suspicious_deposit_cluster';

CREATE INDEX IF NOT EXISTS fiat_email_domain_matches_history_idx
  ON fiat_email_domain_matches (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS fiat_email_domain_matches_risk_history_idx
  ON fiat_email_domain_matches (match_type, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS fiat_email_domain_matches_source_history_idx
  ON fiat_email_domain_matches (match_source, occurred_at DESC, id DESC);
