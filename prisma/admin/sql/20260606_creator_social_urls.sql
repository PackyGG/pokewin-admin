-- Additive columns on creator_socials for per-creator Discord channel + reward page URLs.
-- Provisioned via `prisma db execute` (NOT migrate). Idempotent.

ALTER TABLE "creator_socials"
  ADD COLUMN IF NOT EXISTS "discord_channel_url" TEXT;

ALTER TABLE "creator_socials"
  ADD COLUMN IF NOT EXISTS "reward_page_url" TEXT;
