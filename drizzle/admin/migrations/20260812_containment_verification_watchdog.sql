-- An applied receipt is not enough for critical account protection. Re-check
-- every active critical-signup containment against MAIN and the backend, and
-- repair drift until the related review is resolved by staff.
ALTER TABLE antifraud_signals
  ADD COLUMN IF NOT EXISTS containment_last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS containment_verification_count integer
    NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'antifraud_signals_containment_verification_count_check'
  ) THEN
    ALTER TABLE antifraud_signals
      ADD CONSTRAINT antifraud_signals_containment_verification_count_check
      CHECK (containment_verification_count >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS antifraud_signals_critical_verification_idx
  ON antifraud_signals (
    containment_last_verified_at NULLS FIRST,
    received_at
  )
  WHERE kind = 'critical_risk_signup'
    AND containment_outbox_status = 'applied';
