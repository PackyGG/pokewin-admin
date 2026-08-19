-- Supports the bounded retention pass without scanning snapshot history globally.
-- Existing root/key indexes continue to support newest-snapshot evidence lookups.
CREATE INDEX IF NOT EXISTS network_snapshots_scanned_id_idx
  ON network_snapshots(scanned_at, id);

-- PostgreSQL does not create an index for the referencing side of a foreign key. This keeps
-- both the retention exclusion check and ON DELETE SET NULL case preservation indexed.
CREATE INDEX IF NOT EXISTS cases_network_snapshot_idx
  ON cases(network_snapshot_id)
  WHERE network_snapshot_id IS NOT NULL;
