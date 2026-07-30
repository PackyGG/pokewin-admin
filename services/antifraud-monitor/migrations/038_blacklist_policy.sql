-- Additive follow-up to 037_profile_evidence_foundations.sql. It intentionally
-- changes only the pre-existing email-domain blacklist and its audit stream.
ALTER TABLE fiat_email_domain_blacklist
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS fiat_email_domain_blacklist_expiry_idx
  ON fiat_email_domain_blacklist(expires_at)
  WHERE enabled AND expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_fiat_email_blacklist_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fiat_email_domain_blacklist_audit is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS fiat_email_blacklist_audit_no_update
  ON fiat_email_domain_blacklist_audit;
CREATE TRIGGER fiat_email_blacklist_audit_no_update
  BEFORE UPDATE OR DELETE ON fiat_email_domain_blacklist_audit
  FOR EACH ROW EXECUTE FUNCTION reject_fiat_email_blacklist_audit_mutation();

DROP TRIGGER IF EXISTS fiat_email_blacklist_audit_no_truncate
  ON fiat_email_domain_blacklist_audit;
CREATE TRIGGER fiat_email_blacklist_audit_no_truncate
  BEFORE TRUNCATE ON fiat_email_domain_blacklist_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_fiat_email_blacklist_audit_mutation();
