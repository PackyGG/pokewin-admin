-- Transport-only Antifraud Discord policy and durable review reminder state.
-- No routes are created here: automatic Fraud delivery remains opt-in and
-- Fiat stays off until staff explicitly attach an event to an approved channel.

ALTER TABLE discord_notification_jobs
  ADD COLUMN IF NOT EXISTS components JSONB NOT NULL DEFAULT '[]'::jsonb;

INSERT INTO discord_notification_events
  (event_key, label, description, category, is_custom, enabled)
VALUES
  ('antifraud.account_banned', 'Account banned', 'A fraud-reviewed account was banned.', 'Accounts', false, true),
  ('antifraud.account_locked', 'Account locked', 'An account lock needs staff visibility.', 'Accounts', false, true),
  ('antifraud.review_opened', 'Account review opened', 'A new account review needs staff attention.', 'Accounts', false, true),
  ('antifraud.kyc_required', 'KYC account review', 'A KYC-contained account needs staff review.', 'Accounts', false, true),
  ('antifraud.review_reminder', 'Review reminder', 'An unresolved account review reached its reminder deadline.', 'Accounts', false, true),
  ('antifraud.sumsub_ready', 'Sumsub result ready', 'A Sumsub result is ready for immediate staff review.', 'Accounts', false, true),
  ('antifraud.error.third_party_api', 'Third-party API error', 'A provider or API dependency failed.', 'Errors', false, true),
  ('antifraud.error.discord_command', 'Discord command error', 'A Discord command failed.', 'Errors', false, true),
  ('antifraud.error.system', 'System error', 'An internal code, timeout, or system operation failed.', 'Errors', false, true),
  ('antifraud.error.webapp', 'Webapp error', 'A web, Vercel, or component health check failed.', 'Errors', false, true)
ON CONFLICT (event_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  is_custom = false,
  updated_at = now();

CREATE TABLE IF NOT EXISTS antifraud_review_reminder_state (
  review_id UUID PRIMARY KEY
    REFERENCES antifraud_reviews(id) ON DELETE CASCADE,
  reminder_kind TEXT NOT NULL,
  next_reminder_at TIMESTAMPTZ(6) NOT NULL,
  last_sent_at TIMESTAMPTZ(6),
  sent_count INTEGER NOT NULL DEFAULT 0,
  lease_token UUID,
  leased_until TIMESTAMPTZ(6),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT antifraud_review_reminder_kind_check
    CHECK (reminder_kind IN ('normal', 'urgent', 'postponed')),
  CONSTRAINT antifraud_review_reminder_sent_count_check
    CHECK (sent_count >= 0)
);

CREATE INDEX IF NOT EXISTS antifraud_review_reminder_due_idx
  ON antifraud_review_reminder_state (next_reminder_at, review_id);
