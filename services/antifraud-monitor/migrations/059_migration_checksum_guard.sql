-- Adds a content checksum to schema_migrations so the runner can detect an
-- already-applied migration file being edited after the fact. Existing rows
-- get their checksum backfilled at runtime by migrate.ts (best-effort
-- baseline from the current on-disk file), not here.

ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS checksum text;
