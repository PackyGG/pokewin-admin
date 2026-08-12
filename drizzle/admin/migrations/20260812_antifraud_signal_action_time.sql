CREATE INDEX IF NOT EXISTS antifraud_signals_review_containment_applied_idx
  ON antifraud_signals (review_id, containment_applied_at DESC)
  WHERE review_id IS NOT NULL
    AND containment_applied_at IS NOT NULL;
