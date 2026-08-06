-- Fiat deposit access control: index the two operations-table reads that run on
-- every poller tick.
--
-- 1. `refreshRollout` re-aggregates every operation of a policy on each tick
--    (COUNT/COUNT FILTER + MAX(last_error) FILTER (WHERE status = 'failed')).
--    Before this index that was a sequential scan of the whole operations table,
--    and because a rollout with any failed operation never reaches a terminal
--    state it ran forever. `status()` runs the same shape for new_signups.
--    (policy_id, status) matches the grouping predicate and INCLUDE (last_error)
--    keeps it an index-only scan.
--
-- 2. `process()` opens with the stale-'processing' recovery sweep
--    (WHERE status = 'processing' AND updated_at < now() - interval '2 minutes').
--    That fired on every tick against the full table. A partial index on
--    updated_at restricted to 'processing' matches the predicate exactly and
--    stays tiny: at most DRAIN_SIZE * WORKERS rows are ever in flight.
--
-- The claim query in `drainOperations` is already served by
-- `fiat_deposit_access_operations_drain_idx` from 055. The rollouts table is
-- one row per policy generation, so its status scan needs no index.
--
-- Plain CREATE INDEX (not CONCURRENTLY) on purpose: migrate.ts runs every
-- migration inside a transaction.

CREATE INDEX IF NOT EXISTS fiat_deposit_access_operations_policy_status_idx
  ON fiat_deposit_access_operations (policy_id, status) INCLUDE (last_error);

CREATE INDEX IF NOT EXISTS fiat_deposit_access_operations_processing_stale_idx
  ON fiat_deposit_access_operations (updated_at)
  WHERE status = 'processing';
