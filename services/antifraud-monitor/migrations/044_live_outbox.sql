-- Durable fallback for live-frame publishes. When Redis rejects the atomic
-- XADD+PUBLISH (after its bounded retry), the envelope is parked here and a
-- drain loop republishes it once Redis returns, so a Redis outage no longer
-- deletes committed events from the live history. Ordering caveat: drained
-- events receive later stream ids than frames published while Redis was up,
-- so replay-id ordering across an outage window is eventual, not strict.

CREATE TABLE IF NOT EXISTS live_outbox (
  id bigserial PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
