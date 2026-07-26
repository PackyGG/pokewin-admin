-- Queue search uses prefix ILIKE across these three denormalized text columns.
-- pg_trgm GIN indexes let PostgreSQL satisfy every OR arm without walking the
-- chronological queue, including the matching COUNT(*) query.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS antifraud_reviews_username_trgm_idx
  ON antifraud_reviews USING gin (target_username gin_trgm_ops);

CREATE INDEX IF NOT EXISTS antifraud_reviews_target_user_trgm_idx
  ON antifraud_reviews USING gin (target_user_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS antifraud_reviews_reason_trgm_idx
  ON antifraud_reviews USING gin (reason gin_trgm_ops);
