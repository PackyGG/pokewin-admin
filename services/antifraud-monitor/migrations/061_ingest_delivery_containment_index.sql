-- The dashboard ingest poller ran one six-branch disjunction over `risk_events`
-- every 5 seconds. Branch 1 referenced a post-join column
-- (`fiat_email_domain_matches.lock_delivered_at`), so the whole predicate had
-- to be evaluated after a join whose ON clause concatenated a literal prefix
-- onto a column - no index could serve it and the planner could not BitmapOr
-- the partial indexes that already exist for the other five branches
-- (`risk_events_dashboard_pending_idx`,
-- `risk_events_fiat_containment_pending_idx`,
-- `risk_events_fiat_identity_pending_idx`).
--
-- The poller now reads the blacklist branch as its own query. This partial
-- index drives it: `fiat_blacklisted_email_domain` is a tiny slice of the
-- highest-volume table, and the index supplies the `ORDER BY recorded_at, id`
-- the poller needs so the LIMIT stops the scan immediately.
CREATE INDEX IF NOT EXISTS risk_events_blacklisted_domain_delivery_idx
  ON risk_events(recorded_at, id)
  WHERE event_type = 'fiat_blacklisted_email_domain';
