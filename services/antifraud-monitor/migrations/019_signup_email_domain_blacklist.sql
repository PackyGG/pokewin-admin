ALTER TABLE fiat_email_domain_matches
  ADD COLUMN IF NOT EXISTS match_source text NOT NULL DEFAULT 'whop_checkout';

ALTER TABLE fiat_email_domain_matches
  DROP CONSTRAINT IF EXISTS fiat_email_domain_matches_match_source_check;

ALTER TABLE fiat_email_domain_matches
  ADD CONSTRAINT fiat_email_domain_matches_match_source_check
  CHECK (match_source IN ('whop_checkout', 'signup'));

ALTER TABLE fiat_problem_alert_outbox
  DROP CONSTRAINT IF EXISTS fiat_problem_alert_outbox_source_kind_check;

ALTER TABLE fiat_problem_alert_outbox
  ADD CONSTRAINT fiat_problem_alert_outbox_source_kind_check
  CHECK (source_kind IN ('deposit_intent', 'payment_webhook', 'signup'));
