-- Chat Raffle — drop the knobs the owner removed (2026-07-24).
--
-- Four scoring knobs went away entirely (long-message length + its bonus,
-- the entry floor, the per-user point cap), four eligibility switches became
-- ALWAYS-ON rules rather than per-round columns, and the free-text notes
-- field went with them. Rationale: there is no legitimate round that wants
-- staff winning a player raffle, a muted user cannot chat in the first place,
-- and removing a switch removes the way to get it wrong. Repeat winners are
-- now always allowed, which also keeps each prize place an independent draw
-- at the published odds (see src/lib/chat-raffle/draw.ts).
--
-- Safe to run: verified 0 rows in every chat_raffle_* table before applying,
-- so no round's historic config is being discarded. `IF EXISTS` on every drop
-- keeps it idempotent.
--
-- Applied with `prisma db execute` (this repo's prisma/admin/sql convention),
-- NOT `prisma migrate` / `db push` — the admin DB has a drifted migration
-- history and carries perf indexes that are deliberately unmodeled in
-- schema.prisma, so a diff-based tool would try to drop them.

ALTER TABLE "chat_raffle_rounds"
  DROP COLUMN IF EXISTS "long_message_chars",
  DROP COLUMN IF EXISTS "long_message_bonus_points",
  DROP COLUMN IF EXISTS "min_points_to_enter",
  DROP COLUMN IF EXISTS "max_points_per_user",
  DROP COLUMN IF EXISTS "exclude_staff",
  DROP COLUMN IF EXISTS "exclude_blacklisted",
  DROP COLUMN IF EXISTS "exclude_muted",
  DROP COLUMN IF EXISTS "allow_repeat_winners",
  DROP COLUMN IF EXISTS "notes";
