-- Post-authorization Fiat deposit identity checks.
--
-- The pre-checkout gate (`fiat_eligibility_assessments`) decides whether a
-- checkout may open. It cannot see the two strongest identity facts, because
-- neither exists until Whop authorizes the payment: the card last4/brand and
-- the email the payer actually typed at checkout. This table records what we
-- learned AFTER authorization and how that compared to the account's FIRST
-- authorized deposit — the baseline the player established themselves.
--
-- One row per deposit intent, written once. `verdict` is the decision:
--   'clear'   — nothing drifted.
--   'watch'   — drift that is explainable on its own (IP only, device only, or
--               a card change the account has earned the right to make).
--   'contain' — KYC required and the money rails locked.

CREATE TABLE IF NOT EXISTS fiat_deposit_identity_checks (
  intent_id text PRIMARY KEY,
  user_id text NOT NULL,
  -- NULL when this deposit IS the baseline (the account's first authorized
  -- Fiat deposit). Absolute checks still apply to it; drift checks cannot.
  baseline_intent_id text,
  -- Authorized deposits before this one that never went to dispute or refund.
  prior_clean_deposits integer NOT NULL DEFAULT 0
    CHECK (prior_clean_deposits >= 0),
  card_brand text,
  card_last4 text,
  checkout_email text,
  checkout_email_domain text,
  checkout_ip inet,
  checkout_visitor_id text,
  -- Abstract email reputation for the CHECKOUT address, not the signup one.
  email_catchall boolean,
  email_deliverability text,
  verdict text NOT NULL CHECK (verdict IN ('clear', 'watch', 'contain')),
  reason_codes text[] NOT NULL DEFAULT '{}'::text[],
  watch_codes text[] NOT NULL DEFAULT '{}'::text[],
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 'suppressed' keeps an observe-only window auditable after the fact, the
  -- same vocabulary migration 046 established for checkout enforcement.
  enforcement text NOT NULL DEFAULT 'none'
    CHECK (enforcement IN ('none', 'contained', 'suppressed')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Enforcement can only ever accompany a containment verdict.
  CONSTRAINT fiat_deposit_identity_enforcement_contains_check
    CHECK (enforcement = 'none' OR verdict = 'contain'),
  -- A containment verdict must name the rules that produced it.
  CONSTRAINT fiat_deposit_identity_contain_needs_reason_check
    CHECK (verdict <> 'contain' OR cardinality(reason_codes) > 0)
);

-- Baseline lookup and the per-account history the workspace shows.
CREATE INDEX IF NOT EXISTS fiat_deposit_identity_user_occurred_idx
  ON fiat_deposit_identity_checks (user_id, occurred_at DESC);

-- The review queue: everything that was not clean, newest first.
CREATE INDEX IF NOT EXISTS fiat_deposit_identity_verdict_occurred_idx
  ON fiat_deposit_identity_checks (verdict, occurred_at DESC)
  WHERE verdict <> 'clear';

-- Card reuse across accounts is only answerable with an index on the pair.
CREATE INDEX IF NOT EXISTS fiat_deposit_identity_card_idx
  ON fiat_deposit_identity_checks (card_brand, card_last4)
  WHERE card_last4 IS NOT NULL;

CREATE INDEX IF NOT EXISTS fiat_deposit_identity_email_idx
  ON fiat_deposit_identity_checks (checkout_email)
  WHERE checkout_email IS NOT NULL;

-- Containment events are delivered ahead of the ordinary risk-event stream, so
-- the delivery loop must find undelivered ones without scanning.
CREATE INDEX IF NOT EXISTS risk_events_fiat_identity_pending_idx
  ON risk_events (recorded_at, id)
  WHERE event_type = 'fiat_deposit_identity_containment'
    AND dashboard_delivered_at IS NULL;

-- Seed the cursor at DEPLOY time, not first-run time.
--
-- This is a safety floor, not an optimisation. Without it the first tick would
-- walk every historical authorized deposit, compare each against a baseline
-- established years apart, and mass-lock long-standing customers for card and
-- email changes that were never reviewed under this policy. Only deposits
-- authorized from this migration forward are ever evaluated.
INSERT INTO source_cursors (stream, occurred_at, source_id)
VALUES ('fiat-deposit-identity', now(), '')
ON CONFLICT (stream) DO NOTHING;
