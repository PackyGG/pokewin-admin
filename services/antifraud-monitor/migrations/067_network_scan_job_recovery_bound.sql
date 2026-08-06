-- Bounds stale-lease recovery for network scan jobs. A job that reliably kills its
-- worker used to be re-queued forever and blocked the head of the queue; the runner
-- now fails it once recovery_count reaches its cap (MAX_JOB_RECOVERIES in
-- src/network-risk.ts). Existing rows start at 0, which preserves today's behaviour
-- for anything currently in flight.

ALTER TABLE network_scan_jobs
  ADD COLUMN IF NOT EXISTS recovery_count integer NOT NULL DEFAULT 0;

ALTER TABLE network_scan_jobs
  DROP CONSTRAINT IF EXISTS network_scan_jobs_recovery_count_check;

ALTER TABLE network_scan_jobs
  ADD CONSTRAINT network_scan_jobs_recovery_count_check
    CHECK (recovery_count >= 0);
