CREATE TABLE IF NOT EXISTS admin_whop_refund_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  selection_mode text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT admin_whop_refund_batches_selection_mode_check
    CHECK (selection_mode IN ('payments', 'users', 'all')),
  CONSTRAINT admin_whop_refund_batches_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'completed_with_issues')),
  CONSTRAINT admin_whop_refund_batches_requested_count_check
    CHECK (requested_count >= 0)
);

CREATE INDEX IF NOT EXISTS admin_whop_refund_batches_requested_created_idx
  ON admin_whop_refund_batches (requested_by, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_whop_refund_batches_status_updated_idx
  ON admin_whop_refund_batches (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS admin_whop_refund_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES admin_whop_refund_batches(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  deposit_intent_id uuid NOT NULL,
  provider_payment_id text NOT NULL,
  currency text NOT NULL,
  original_amount_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  lease_token uuid,
  leased_until timestamptz,
  provider_status text,
  provider_substatus text,
  refunded_amount numeric(20, 2),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT admin_whop_refund_items_payment_unique UNIQUE (provider_payment_id),
  CONSTRAINT admin_whop_refund_items_status_check
    CHECK (status IN (
      'pending',
      'processing',
      'succeeded',
      'already_refunded',
      'not_refundable',
      'failed',
      'unknown'
    )),
  CONSTRAINT admin_whop_refund_items_amount_check
    CHECK (original_amount_cents > 0),
  CONSTRAINT admin_whop_refund_items_attempt_count_check
    CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS admin_whop_refund_items_batch_status_idx
  ON admin_whop_refund_items (batch_id, status, created_at);

CREATE INDEX IF NOT EXISTS admin_whop_refund_items_user_created_idx
  ON admin_whop_refund_items (user_id, created_at DESC);
