-- Creator approval requests gain two things:
--   1. an optional bundled affiliate leaderboard (site-funded) alongside the
--      deal and the reward program, and
--   2. a request KIND, so a leaderboard or a reward program can be sent for
--      Discord approval on its own, with no deal and no terms-of-service step.
--
-- The deal window used to be the only source of "when does this request run".
-- It is promoted to first-class window_start_at / window_end_at columns so
-- expiry, scheduling, and reward-program accrual stop assuming deal_payload
-- exists. ADMIN database only.

ALTER TABLE creator_deal_approval_requests
  ADD COLUMN IF NOT EXISTS leaderboard_payload JSONB,
  ADD COLUMN IF NOT EXISTS leaderboard_id UUID,
  ADD COLUMN IF NOT EXISTS request_kind TEXT NOT NULL DEFAULT 'deal',
  ADD COLUMN IF NOT EXISTS window_start_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS window_end_at TIMESTAMPTZ(6);

-- Backfill from the immutable deal snapshot before the columns go NOT NULL.
-- Every pre-existing row is a deal request by definition.
UPDATE creator_deal_approval_requests
SET window_start_at = COALESCE(window_start_at, (deal_payload ->> 'week_start_utc')::timestamptz),
    window_end_at   = COALESCE(window_end_at,   (deal_payload ->> 'week_end_utc')::timestamptz)
WHERE window_start_at IS NULL OR window_end_at IS NULL;

ALTER TABLE creator_deal_approval_requests
  ALTER COLUMN window_start_at SET NOT NULL,
  ALTER COLUMN window_end_at SET NOT NULL,
  ALTER COLUMN deal_payload DROP NOT NULL;

-- The payload check has to tolerate a NULL deal_payload now, and cover the
-- new leaderboard payload.
ALTER TABLE creator_deal_approval_requests
  DROP CONSTRAINT IF EXISTS creator_deal_approval_payload_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creator_deal_approval_payload_check'
      AND conrelid = 'creator_deal_approval_requests'::regclass
  ) THEN
    ALTER TABLE creator_deal_approval_requests
      ADD CONSTRAINT creator_deal_approval_payload_check CHECK (
        (deal_payload IS NULL OR jsonb_typeof(deal_payload) = 'object') AND
        (reward_payload IS NULL OR jsonb_typeof(reward_payload) = 'object') AND
        (leaderboard_payload IS NULL OR jsonb_typeof(leaderboard_payload) = 'object') AND
        jsonb_typeof(agreement_lines) = 'array' AND jsonb_array_length(agreement_lines) > 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creator_deal_approval_request_kind_check'
      AND conrelid = 'creator_deal_approval_requests'::regclass
  ) THEN
    ALTER TABLE creator_deal_approval_requests
      ADD CONSTRAINT creator_deal_approval_request_kind_check
      CHECK (request_kind IN ('deal', 'leaderboard_only', 'rewards_only'));
  END IF;

  -- A single-purpose request carries exactly its own payload and nothing
  -- else, so provisioning can branch on the kind alone.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creator_deal_approval_kind_payload_check'
      AND conrelid = 'creator_deal_approval_requests'::regclass
  ) THEN
    ALTER TABLE creator_deal_approval_requests
      ADD CONSTRAINT creator_deal_approval_kind_payload_check CHECK (
        (request_kind = 'deal' AND deal_payload IS NOT NULL)
        OR (request_kind = 'leaderboard_only'
            AND leaderboard_payload IS NOT NULL
            AND deal_payload IS NULL
            AND reward_payload IS NULL)
        OR (request_kind = 'rewards_only'
            AND reward_payload IS NOT NULL
            AND deal_payload IS NULL
            AND leaderboard_payload IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creator_deal_approval_window_check'
      AND conrelid = 'creator_deal_approval_requests'::regclass
  ) THEN
    ALTER TABLE creator_deal_approval_requests
      ADD CONSTRAINT creator_deal_approval_window_check
      CHECK (window_end_at > window_start_at);
  END IF;
END $$;

-- "One unresolved request per creator" becomes "one unresolved request per
-- creator PER KIND". Deal behaviour is unchanged; a standalone leaderboard or
-- rewards approval no longer collides with a pending deal approval.
DROP INDEX IF EXISTS creator_deal_approval_one_unresolved_creator;
CREATE UNIQUE INDEX IF NOT EXISTS creator_deal_approval_one_unresolved_creator
  ON creator_deal_approval_requests (creator_user_id, request_kind)
  WHERE status IN (
    'pending_delivery', 'awaiting_continue', 'awaiting_decision',
    'approved_provisioning', 'provisioning_failed', 'delivery_failed'
  );

COMMENT ON COLUMN creator_deal_approval_requests.request_kind IS
  'deal | leaderboard_only | rewards_only. Non-deal kinds skip the terms-of-service continue step entirely.';
COMMENT ON COLUMN creator_deal_approval_requests.leaderboard_payload IS
  'Immutable proposal for a site-funded affiliate leaderboard provisioned on approval. Null when the request bundles no leaderboard.';
COMMENT ON COLUMN creator_deal_approval_requests.leaderboard_id IS
  'MAIN affiliate leaderboard id written after provisioning. Unlike deals there is no remote marker field, so this is the only idempotency anchor.';
COMMENT ON COLUMN creator_deal_approval_requests.window_start_at IS
  'Canonical request window start. Deal requests mirror deal_payload.week_start_utc; other kinds carry their own window.';
COMMENT ON COLUMN creator_deal_approval_requests.window_end_at IS
  'Canonical request window end. Drives expiry, scheduling, and reward-program accrual for every kind.';
