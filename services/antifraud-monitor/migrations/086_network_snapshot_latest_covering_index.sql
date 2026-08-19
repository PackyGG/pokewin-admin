-- The active-cluster queries select the newest recent snapshot for every
-- network. At production cardinality that operation ran every poller tick and
-- sorted the whole 30-day snapshot window, spilling under the safe 4MB
-- work_mem default. Include the selected id in recency order so PostgreSQL can
-- stream DISTINCT ON from an index-only scan without a temporary sort.
CREATE INDEX IF NOT EXISTS network_snapshots_key_scanned_id_idx
  ON network_snapshots(network_key, scanned_at DESC, id DESC);

-- The new index has the old index as an exact leading prefix, so retaining
-- both would add snapshot-write amplification and about 34MB of duplicate
-- production index storage without enabling another access path.
DROP INDEX IF EXISTS network_snapshots_key_scanned_idx;
