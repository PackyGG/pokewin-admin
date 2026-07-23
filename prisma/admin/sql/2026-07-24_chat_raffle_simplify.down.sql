-- Rollback for 2026-07-24_chat_raffle_simplify.up.sql.
--
-- Restores the dropped columns with their ORIGINAL defaults. Any values that
-- existed before the drop are gone (the up-migration ran against 0 rows, so
-- nothing was actually lost); rounds created in between get the defaults.
--
-- NOTE `allow_repeat_winners` comes back defaulting to FALSE, which was the
-- original default — not the always-on behaviour that replaced it. Restoring
-- the column alone does not restore the old draw semantics; the code in
-- src/lib/chat-raffle/draw.ts would have to be reverted too.

ALTER TABLE "chat_raffle_rounds"
  ADD COLUMN IF NOT EXISTS "long_message_chars"        INTEGER NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS "long_message_bonus_points" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "min_points_to_enter"       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "max_points_per_user"       INTEGER,
  ADD COLUMN IF NOT EXISTS "exclude_staff"             BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "exclude_blacklisted"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "exclude_muted"             BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "allow_repeat_winners"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "notes"                     TEXT;
