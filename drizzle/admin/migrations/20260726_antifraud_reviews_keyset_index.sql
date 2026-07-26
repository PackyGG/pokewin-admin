-- Stable keyset pagination for the antifraud review queue.
-- Applied through: npm run admin:sql -- drizzle/admin/migrations/20260726_antifraud_reviews_keyset_index.sql
CREATE INDEX IF NOT EXISTS antifraud_reviews_created_id_idx
  ON antifraud_reviews (created_at DESC, id DESC);
