-- One durable completion marker per review/domain. The flagged review and its
-- signal are the retry queue; this index makes overlapping UI/cron repair
-- attempts idempotent after the monitor confirms promotion.
CREATE UNIQUE INDEX IF NOT EXISTS admin_audit_catchall_promotion_unique_idx
  ON admin_audit_events (
    (metadata ->> 'reviewId'),
    (metadata ->> 'domain')
  )
  WHERE event_type = 'antifraud_catchall_domain_promoted'
    AND metadata ? 'reviewId'
    AND metadata ? 'domain';

CREATE UNIQUE INDEX IF NOT EXISTS admin_audit_catchall_lock_snapshot_unique_idx
  ON admin_audit_events ((metadata ->> 'signalRowId'))
  WHERE event_type IN (
      'antifraud_catchall_lock_snapshot',
      'antifraud_catchall_reward_lock_snapshot'
    )
    AND metadata ? 'signalRowId';
