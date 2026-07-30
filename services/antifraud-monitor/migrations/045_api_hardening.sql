-- 045_api_hardening.sql
--
-- Index support for the read routes hardened in the API pass. Migrations run
-- inside a transaction at boot, so plain CREATE INDEX (not CONCURRENTLY) is
-- required here; every index is IF NOT EXISTS and therefore idempotent.

-- GET /v1/cases/:id evidence: events for a case in occurred/recorded order.
CREATE INDEX IF NOT EXISTS risk_events_case_occurred_idx
  ON risk_events(case_id, occurred_at, recorded_at)
  WHERE case_id IS NOT NULL;

-- GET /v1/cases/:id evidence: staff actions for a case in created order.
CREATE INDEX IF NOT EXISTS staff_actions_case_created_idx
  ON staff_actions(case_id, created_at);

-- GET /v1/cases/:id evidence: rule matches for a case in matched order.
CREATE INDEX IF NOT EXISTS rule_matches_case_matched_idx
  ON rule_matches(case_id, matched_at);

-- /v1/overview blocked-IP metric: hard-policy signals joined to history.
CREATE INDEX IF NOT EXISTS profile_assessment_signals_hard_policy_idx
  ON profile_assessment_signals(hard_policy, assessment_id)
  WHERE hard_policy IS NOT NULL;

-- Latest proxycheck row per user (LATERAL on /v1/signups, /v1/cases,
-- /v1/monitors/live).
CREATE INDEX IF NOT EXISTS provider_checks_proxycheck_latest_idx
  ON provider_checks(user_id, checked_at DESC)
  WHERE provider = 'proxycheck';

-- /v1/monitors/live: active sessions ranked by current score.
CREATE INDEX IF NOT EXISTS monitor_sessions_active_score_idx
  ON monitor_sessions(current_score DESC, started_at)
  WHERE status = 'active';

-- /v1/overview fiat review queue counter.
CREATE INDEX IF NOT EXISTS fiat_deposit_assessments_review_queue_idx
  ON fiat_deposit_assessments(review_status)
  WHERE verdict IN ('review','bad');

-- /v1/signups/unseen-count now filters on the ingestion clock.
CREATE INDEX IF NOT EXISTS subjects_first_seen_idx
  ON subjects(first_seen_at DESC);

-- GET /v1/cases list: status filter plus the exact severity-rank ordering.
-- Keep the expression byte-for-byte aligned with GET /v1/cases.
CREATE INDEX IF NOT EXISTS cases_status_severity_rank_updated_idx
  ON cases (
    status,
    (CASE severity
      WHEN 'critical' THEN 4 WHEN 'high' THEN 3
      WHEN 'medium' THEN 2 ELSE 1
    END) DESC,
    updated_at DESC
  );
