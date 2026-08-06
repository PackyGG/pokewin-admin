-- Evidence-only pre/post Fiat detections. These facts are intentionally kept
-- separate from action policy so adding a detector cannot lock an account.
ALTER TABLE fiat_deposit_assessments
  ADD COLUMN IF NOT EXISTS detection_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

