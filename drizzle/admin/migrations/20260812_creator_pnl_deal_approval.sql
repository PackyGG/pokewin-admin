-- Add first-class positive-P&L deals to the durable Discord creator-approval
-- workflow. The approved commercial contract and settlement are ADMIN-owned;
-- only an ordinary linked fill/multiplier funding record lives in MAIN.

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
  'Immutable positive-P&L proposal used to create an ADMIN-owned contract after Discord approval.';

-- The commercial P&L contract and its settlement lifecycle belong to the
-- ADMIN database. Only the optional funding mechanism is provisioned through
-- the existing customer-backend fill/multiplier APIs.
CREATE TABLE IF NOT EXISTS creator_pnl_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_user_id TEXT NOT NULL,
  source_approval_request_id UUID NOT NULL UNIQUE
    REFERENCES creator_deal_approval_requests(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  frame_start_utc TIMESTAMPTZ(6) NOT NULL,
  frame_end_utc TIMESTAMPTZ(6) NOT NULL,
  positive_pnl_share_bps INTEGER NOT NULL,
  funding_mode TEXT NOT NULL,
  funding_config JSONB NOT NULL,
  linked_fill_deal_id UUID,
  linked_multiplier_deal_id UUID,
  max_tip_per_stream_usd NUMERIC(20, 2),
  max_tip_per_user_usd NUMERIC(20, 2),
  max_sponsored_battle_usd NUMERIC(20, 2),
  max_sponsorship_per_stream_usd NUMERIC(20, 2),
  terms_snapshot JSONB NOT NULL,
  frame_site_pnl_usd NUMERIC(20, 2),
  creator_share_usd NUMERIC(20, 2),
  settlement_breakdown JSONB,
  settlement_reason TEXT,
  credit_status TEXT NOT NULL DEFAULT 'not_ready',
  credit_idempotency_key TEXT NOT NULL,
  credit_attempted_at TIMESTAMPTZ(6),
  credit_error TEXT,
  credited_amount_usd NUMERIC(20, 2),
  credit_ledger_id UUID,
  credited_by_admin_user_id UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
  credited_at TIMESTAMPTZ(6),
  activated_at TIMESTAMPTZ(6),
  calculation_started_at TIMESTAMPTZ(6),
  calculated_at TIMESTAMPTZ(6),
  settled_at TIMESTAMPTZ(6),
  cancelled_at TIMESTAMPTZ(6),
  cancellation_reason TEXT,
  created_by_admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT creator_pnl_deals_creator_user_check CHECK (
    length(creator_user_id) BETWEEN 8 AND 64
    AND creator_user_id ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT creator_pnl_deals_status_check CHECK (
    status IN ('scheduled', 'active', 'settlement_pending', 'calculated', 'crediting', 'settled', 'cancelled')
  ),
  CONSTRAINT creator_pnl_deals_frame_check CHECK (frame_end_utc > frame_start_utc),
  CONSTRAINT creator_pnl_deals_share_check CHECK (
    positive_pnl_share_bps BETWEEN 1 AND 10000
  ),
  CONSTRAINT creator_pnl_deals_funding_mode_check CHECK (
    funding_mode IN ('non_withdrawable_fills', 'linked_multiplier', 'new_multiplier')
  ),
  CONSTRAINT creator_pnl_deals_funding_config_check CHECK (
    jsonb_typeof(funding_config) = 'object'
  ),
  CONSTRAINT creator_pnl_deals_funding_link_check CHECK (
    (funding_mode = 'non_withdrawable_fills'
      AND linked_fill_deal_id IS NOT NULL AND linked_multiplier_deal_id IS NULL)
    OR (funding_mode IN ('linked_multiplier', 'new_multiplier')
      AND linked_multiplier_deal_id IS NOT NULL AND linked_fill_deal_id IS NULL)
  ),
  CONSTRAINT creator_pnl_deals_terms_check CHECK (
    jsonb_typeof(terms_snapshot) = 'object'
  ),
  CONSTRAINT creator_pnl_deals_caps_check CHECK (
    (max_tip_per_stream_usd IS NULL OR max_tip_per_stream_usd >= 0)
    AND (max_tip_per_user_usd IS NULL OR max_tip_per_user_usd >= 0)
    AND (max_sponsored_battle_usd IS NULL OR max_sponsored_battle_usd >= 0)
    AND (max_sponsorship_per_stream_usd IS NULL OR max_sponsorship_per_stream_usd >= 0)
  ),
  CONSTRAINT creator_pnl_deals_credit_status_check CHECK (
    credit_status IN ('not_ready', 'ready', 'crediting', 'credited', 'failed')
  ),
  CONSTRAINT creator_pnl_deals_credit_idempotency_check CHECK (
    credit_idempotency_key = 'creator-pnl:' || id::text
  ),
  CONSTRAINT creator_pnl_deals_credit_amount_check CHECK (
    credited_amount_usd IS NULL OR credited_amount_usd >= 0
  ),
  CONSTRAINT creator_pnl_deals_version_check CHECK (version > 0),
  CONSTRAINT creator_pnl_deals_settlement_shape_check CHECK (
    status <> 'settled'
    OR (settlement_breakdown IS NOT NULL
      AND frame_site_pnl_usd IS NOT NULL
      AND creator_share_usd IS NOT NULL
      AND credited_amount_usd IS NOT NULL
      AND credit_ledger_id IS NOT NULL
      AND credited_by_admin_user_id IS NOT NULL
      AND credited_at IS NOT NULL
      AND settled_at IS NOT NULL
      AND credit_status = 'credited')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_pnl_deals_credit_idempotency_unique
  ON creator_pnl_deals (credit_idempotency_key);
CREATE INDEX IF NOT EXISTS creator_pnl_deals_creator_history_idx
  ON creator_pnl_deals (creator_user_id, frame_start_utc DESC, id DESC);
CREATE INDEX IF NOT EXISTS creator_pnl_deals_calculation_queue_idx
  ON creator_pnl_deals (frame_end_utc, created_at, id)
  WHERE status IN ('active', 'settlement_pending');
CREATE INDEX IF NOT EXISTS creator_pnl_deals_credit_queue_idx
  ON creator_pnl_deals (calculated_at, id)
  WHERE status IN ('calculated', 'crediting');

ALTER TABLE creator_deal_approval_requests
  ADD COLUMN IF NOT EXISTS pnl_deal_id UUID;

ALTER TABLE creator_deal_approval_requests
  DROP CONSTRAINT IF EXISTS creator_deal_approval_requests_pnl_deal_id_fkey,
  ADD CONSTRAINT creator_deal_approval_requests_pnl_deal_id_fkey
    FOREIGN KEY (pnl_deal_id) REFERENCES creator_pnl_deals(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS creator_deal_approval_requests_pnl_deal_unique
  ON creator_deal_approval_requests (pnl_deal_id)
  WHERE pnl_deal_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_creator_pnl_deal_immutable_contract()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.creator_user_id IS DISTINCT FROM OLD.creator_user_id
    OR NEW.source_approval_request_id IS DISTINCT FROM OLD.source_approval_request_id
    OR NEW.frame_start_utc IS DISTINCT FROM OLD.frame_start_utc
    OR NEW.frame_end_utc IS DISTINCT FROM OLD.frame_end_utc
    OR NEW.positive_pnl_share_bps IS DISTINCT FROM OLD.positive_pnl_share_bps
    OR NEW.funding_mode IS DISTINCT FROM OLD.funding_mode
    OR NEW.funding_config IS DISTINCT FROM OLD.funding_config
    OR NEW.linked_fill_deal_id IS DISTINCT FROM OLD.linked_fill_deal_id
    OR NEW.linked_multiplier_deal_id IS DISTINCT FROM OLD.linked_multiplier_deal_id
    OR NEW.max_tip_per_stream_usd IS DISTINCT FROM OLD.max_tip_per_stream_usd
    OR NEW.max_tip_per_user_usd IS DISTINCT FROM OLD.max_tip_per_user_usd
    OR NEW.max_sponsored_battle_usd IS DISTINCT FROM OLD.max_sponsored_battle_usd
    OR NEW.max_sponsorship_per_stream_usd IS DISTINCT FROM OLD.max_sponsorship_per_stream_usd
    OR NEW.terms_snapshot IS DISTINCT FROM OLD.terms_snapshot
    OR NEW.credit_idempotency_key IS DISTINCT FROM OLD.credit_idempotency_key
    OR NEW.created_by_admin_user_id IS DISTINCT FROM OLD.created_by_admin_user_id
  THEN
    RAISE EXCEPTION 'creator_pnl_deals immutable contract columns cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS creator_pnl_deals_immutable_contract_guard ON creator_pnl_deals;
CREATE TRIGGER creator_pnl_deals_immutable_contract_guard
  BEFORE UPDATE ON creator_pnl_deals
  FOR EACH ROW EXECUTE FUNCTION guard_creator_pnl_deal_immutable_contract();

COMMENT ON TABLE creator_pnl_deals IS
  'ADMIN-owned immutable creator P&L contracts and manually credited settlement lifecycle. Linked deal IDs refer to existing customer-backend funding records.';
COMMENT ON COLUMN creator_pnl_deals.credit_idempotency_key IS
  'Stable MAIN ledger external_tx_id; creator-pnl:<deal-id>. Reserved before crediting.';
