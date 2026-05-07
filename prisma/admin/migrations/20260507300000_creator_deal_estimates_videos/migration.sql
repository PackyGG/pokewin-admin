-- creator_deal_estimates: add video deal terms
-- Same shape as daily fill (amount + % + fills) but for videos.
-- Counts into the same weekly bucket as the withdraw cap.
-- Idempotent — safe to re-run.

ALTER TABLE "creator_deal_estimates"
  ADD COLUMN IF NOT EXISTS "video_amount_usd"     NUMERIC(20, 2),
  ADD COLUMN IF NOT EXISTS "video_percent"        NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS "video_fills_per_week" INTEGER;
