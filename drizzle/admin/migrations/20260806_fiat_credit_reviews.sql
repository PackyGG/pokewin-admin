CREATE TABLE IF NOT EXISTS admin_fiat_credit_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_intent_id uuid NOT NULL UNIQUE,
  user_id text NOT NULL,
  provider text NOT NULL DEFAULT 'whop',
  provider_payment_id text NOT NULL UNIQUE,
  currency text NOT NULL,
  amount_cents integer NOT NULL,
  customer_total_cents integer,
  status text NOT NULL DEFAULT 'active',
  staff_decision text,
  decision_reason text,
  decided_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  decision_idempotency_key uuid UNIQUE,
  decided_at timestamptz,
  containment_error text,
  contained_at timestamptz,
  resolution_action text,
  resolution_reason text,
  resolution_idempotency_key uuid UNIQUE,
  resolution_requested_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  resolution_requested_at timestamptz,
  refund_status text NOT NULL DEFAULT 'not_requested',
  provider_status text,
  provider_substatus text,
  refunded_amount numeric(20,2),
  refund_error_code text,
  refund_error_message text,
  refund_completed_at timestamptz,
  ban_status text NOT NULL DEFAULT 'not_requested',
  ban_error_message text,
  ban_completed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  resolved_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_fiat_credit_reviews_provider_check
    CHECK (provider = 'whop'),
  CONSTRAINT admin_fiat_credit_reviews_amount_check
    CHECK (amount_cents > 0 AND (customer_total_cents IS NULL OR customer_total_cents > 0)),
  CONSTRAINT admin_fiat_credit_reviews_status_check
    CHECK (status IN (
      'active', 'approving', 'approval_failed', 'approved',
      'containing', 'containment_failed', 'declined',
      'resolving', 'resolution_failed', 'resolved'
    )),
  CONSTRAINT admin_fiat_credit_reviews_staff_decision_check
    CHECK (staff_decision IS NULL OR staff_decision IN ('approve', 'decline')),
  CONSTRAINT admin_fiat_credit_reviews_decision_reason_check
    CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 3 AND 500),
  CONSTRAINT admin_fiat_credit_reviews_resolution_action_check
    CHECK (resolution_action IS NULL OR resolution_action IN ('refund', 'ban', 'refund_and_ban')),
  CONSTRAINT admin_fiat_credit_reviews_resolution_reason_check
    CHECK (resolution_reason IS NULL OR char_length(resolution_reason) BETWEEN 3 AND 500),
  CONSTRAINT admin_fiat_credit_reviews_refund_status_check
    CHECK (refund_status IN (
      'not_requested', 'processing', 'succeeded', 'already_refunded',
      'not_refundable', 'failed', 'unknown'
    )),
  CONSTRAINT admin_fiat_credit_reviews_ban_status_check
    CHECK (ban_status IN ('not_requested', 'processing', 'succeeded', 'already_banned', 'failed')),
  CONSTRAINT admin_fiat_credit_reviews_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT admin_fiat_credit_reviews_version_check CHECK (version >= 0)
);

CREATE INDEX IF NOT EXISTS admin_fiat_credit_reviews_status_created_idx
  ON admin_fiat_credit_reviews (status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_fiat_credit_reviews_user_created_idx
  ON admin_fiat_credit_reviews (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_fiat_credit_reviews_declined_idx
  ON admin_fiat_credit_reviews (decided_at DESC, id DESC)
  WHERE staff_decision = 'decline';
