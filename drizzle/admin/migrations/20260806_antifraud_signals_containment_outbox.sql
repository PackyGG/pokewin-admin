-- Durable outbox state for containment that must run AFTER the ingest
-- transaction commits (fiat_eligibility_containment, fiat_deposit_identity_containment).
--
-- Those two kinds are the only ones whose MAIN-DB write (and, for identity,
-- a backend KYC HTTP call) used to run INSIDE the open adminDrizzle
-- transaction in src/app/api/antifraud/ingest/route.ts. Moving that work to
-- after commit means a crash or transient failure between commit and the
-- external call can no longer be recovered by rolling back + redelivering
-- (the signal row already committed, so a redelivery is deduped). These
-- columns make that gap durable and retryable instead of silent:
--   pending -> set inside the transaction when a signal validates as
--              requiring containment, before commit.
--   applied -> the post-commit containment call succeeded.
--   skipped -> the post-commit call ran and determined containment does not
--              apply (e.g. the account no longer exists) — a permanent,
--              not-retryable outcome.
--   failed  -> the post-commit call threw (transient error). Retried by the
--              /api/cron/antifraud-containment-retry sweep until
--              containment_outbox_attempts hits the cap, using only columns
--              already stored on the row (kind, target_user_id, risk_score,
--              payload) to reconstruct the containment target.

ALTER TABLE antifraud_signals
  ADD COLUMN IF NOT EXISTS containment_outbox_status text,
  ADD COLUMN IF NOT EXISTS containment_outbox_error text,
  ADD COLUMN IF NOT EXISTS containment_outbox_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS containment_applied_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'antifraud_signals_containment_outbox_status_check'
  ) THEN
    ALTER TABLE antifraud_signals
      ADD CONSTRAINT antifraud_signals_containment_outbox_status_check
      CHECK (containment_outbox_status IS NULL OR containment_outbox_status IN (
        'pending', 'applied', 'skipped', 'failed'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'antifraud_signals_containment_outbox_attempts_check'
  ) THEN
    ALTER TABLE antifraud_signals
      ADD CONSTRAINT antifraud_signals_containment_outbox_attempts_check
      CHECK (containment_outbox_attempts >= 0);
  END IF;
END $$;

-- Cheap scan target for the retry cron: only rows still owed a containment
-- attempt, oldest first.
CREATE INDEX IF NOT EXISTS antifraud_signals_containment_outbox_pending_idx
  ON antifraud_signals (received_at)
  WHERE containment_outbox_status IN ('pending', 'failed');
