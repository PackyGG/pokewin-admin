-- The fiat deposit API contract exposes `provider_payment_id` (the Whop
-- payment id) so the dashboard can resolve refund state per deposit, but the
-- assessment table never stored it. Add it additively; the next refresh pass
-- backfills every visible row through the existing upsert.
ALTER TABLE fiat_deposit_assessments
  ADD COLUMN IF NOT EXISTS provider_payment_id text;
