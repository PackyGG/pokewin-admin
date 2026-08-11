-- Add first-class positive-P&L deals to the durable Discord creator-approval
-- workflow. ADMIN database only; the approved deal itself remains owned by
-- the customer backend.

ALTER TABLE creator_deal_approval_requests
  ADD COLUMN IF NOT EXISTS pnl_payload JSONB;

ALTER TABLE creator_deal_approval_requests
  DROP CONSTRAINT IF EXISTS creator_deal_approval_payload_check,
  DROP CONSTRAINT IF EXISTS creator_deal_approval_request_kind_check,
  DROP CONSTRAINT IF EXISTS creator_deal_approval_kind_payload_check;

ALTER TABLE creator_deal_approval_requests
  ADD CONSTRAINT creator_deal_approval_payload_check CHECK (
    (deal_payload IS NULL OR jsonb_typeof(deal_payload) = 'object') AND
    (multiplier_payload IS NULL OR jsonb_typeof(multiplier_payload) = 'object') AND
    (pnl_payload IS NULL OR jsonb_typeof(pnl_payload) = 'object') AND
    (reward_payload IS NULL OR jsonb_typeof(reward_payload) = 'object') AND
    (leaderboard_payload IS NULL OR jsonb_typeof(leaderboard_payload) = 'object') AND
    jsonb_typeof(agreement_lines) = 'array' AND jsonb_array_length(agreement_lines) > 0
  ),
  ADD CONSTRAINT creator_deal_approval_request_kind_check CHECK (
    request_kind IN ('deal', 'multiplier_deal', 'pnl_deal', 'leaderboard_only', 'rewards_only')
  ),
  ADD CONSTRAINT creator_deal_approval_kind_payload_check CHECK (
    (request_kind = 'deal'
      AND deal_payload IS NOT NULL AND multiplier_payload IS NULL AND pnl_payload IS NULL)
    OR (request_kind = 'multiplier_deal'
      AND multiplier_payload IS NOT NULL AND deal_payload IS NULL AND pnl_payload IS NULL
      AND reward_payload IS NULL AND leaderboard_payload IS NULL)
    OR (request_kind = 'pnl_deal'
      AND pnl_payload IS NOT NULL AND deal_payload IS NULL AND multiplier_payload IS NULL)
    OR (request_kind = 'leaderboard_only'
      AND leaderboard_payload IS NOT NULL AND deal_payload IS NULL
      AND multiplier_payload IS NULL AND pnl_payload IS NULL AND reward_payload IS NULL)
    OR (request_kind = 'rewards_only'
      AND reward_payload IS NOT NULL AND deal_payload IS NULL
      AND multiplier_payload IS NULL AND pnl_payload IS NULL AND leaderboard_payload IS NULL)
  );

-- Fill, multiplier, and P&L offers are mutually exclusive unresolved deal
-- proposals. Standalone reward and leaderboard approvals retain their own
-- independent slots.
DROP INDEX IF EXISTS creator_deal_approval_one_unresolved_creator;
CREATE UNIQUE INDEX creator_deal_approval_one_unresolved_creator
  ON creator_deal_approval_requests (
    creator_user_id,
    (CASE WHEN request_kind IN ('deal', 'multiplier_deal', 'pnl_deal') THEN 'deal' ELSE request_kind END)
  )
  WHERE status IN (
    'pending_delivery', 'awaiting_continue', 'awaiting_decision',
    'approved_provisioning', 'provisioning_failed', 'delivery_failed'
  );

COMMENT ON COLUMN creator_deal_approval_requests.request_kind IS
  'deal | multiplier_deal | pnl_deal | leaderboard_only | rewards_only. Every deal kind requires the terms-of-service step.';
COMMENT ON COLUMN creator_deal_approval_requests.pnl_payload IS
  'Immutable positive-P&L deal proposal provisioned in the customer backend only after Discord approval.';
