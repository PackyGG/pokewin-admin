-- Ordinary manual-review rule matches used to reserve only a Discord alert.
-- The alert linked by monitor case id, but no signed risk event crossed into
-- the Admin database, so the Account Review popup had no review id to resolve.
--
-- Backfill every still-pending alert plus recently delivered alerts (so links
-- already posted during the rollout begin working), without reopening the
-- entire historical rule-match archive.
INSERT INTO risk_events (
  case_id,
  session_id,
  user_id,
  event_type,
  source,
  source_ref,
  score_delta,
  score_after,
  title,
  detail,
  payload,
  occurred_at
)
SELECT
  match.case_id,
  match.session_id,
  fraud_case.user_id,
  'behavioral_rule_match',
  'rule_matches',
  'rule-match:' || match.id::text,
  definition.score_delta,
  fraud_case.score,
  COALESCE(alert.payload ->> 'title', 'Behavior rule matched'),
  COALESCE(
    alert.payload ->> 'description',
    'A monitored account matched an antifraud rule and needs support review.'
  ),
  jsonb_build_object(
    'reviewOnly', true,
    'modelVersion', 'behavior-v1',
    'reasonCode', definition.key,
    'actionType', definition.action_type,
    'ruleId', definition.id,
    'evidence', match.evidence
  ),
  match.matched_at
FROM rule_alert_outbox alert
JOIN rule_matches match ON match.id = alert.rule_match_id
JOIN rule_definitions definition ON definition.id = match.rule_id
JOIN cases fraud_case ON fraud_case.id = match.case_id
WHERE definition.action_type <> 'lock_withdrawals'
  AND (
    alert.delivered_at IS NULL
    OR alert.created_at >= now() - interval '24 hours'
  )
ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
DO NOTHING;
