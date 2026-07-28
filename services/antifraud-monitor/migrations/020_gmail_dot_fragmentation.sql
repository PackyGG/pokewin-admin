ALTER TABLE fiat_email_domain_matches
  ADD COLUMN IF NOT EXISTS match_type text NOT NULL
  DEFAULT 'blacklisted_domain';

ALTER TABLE fiat_email_domain_matches
  DROP CONSTRAINT IF EXISTS fiat_email_domain_matches_match_type_check;

ALTER TABLE fiat_email_domain_matches
  ADD CONSTRAINT fiat_email_domain_matches_match_type_check
  CHECK (match_type IN ('blacklisted_domain', 'gmail_dot_fragmentation'));
