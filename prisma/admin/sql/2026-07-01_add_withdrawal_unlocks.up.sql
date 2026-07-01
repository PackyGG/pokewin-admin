-- Per-user withdrawal UNLOCK override (admin DB).
--
-- Withdrawal-lock policy: every user on the `excluded_users` blacklist
-- is withdrawal-LOCKED BY DEFAULT (their withdrawals cannot be actioned
-- through the admin panel). The presence of a row here is a per-user
-- UNLOCK override that motha (the root owner) has granted, re-enabling
-- withdrawal actions for that single user. Absence of a row = locked
-- (when the user is excluded).
--
-- Only the main owner (motha) may create or remove rows here — enforced
-- server-side in the withdrawal-unlock actions. This table is purely an
-- override flag; it never holds money or user data.
--
-- Additive, applied via `prisma db execute` (NOT db push / migrate — the
-- admin DB has drifted migration history). Runtime reads fail-safe: a
-- missing table degrades to "no unlock override" (i.e. excluded users
-- stay locked), never crashing the withdrawal surface.
CREATE TABLE IF NOT EXISTS "admin_withdrawal_unlocks" (
  "target_user_id" TEXT PRIMARY KEY,
  "unlocked_by"    UUID,
  "unlocked_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "notes"          TEXT,
  CONSTRAINT "admin_withdrawal_unlocks_unlocked_by_fkey"
    FOREIGN KEY ("unlocked_by") REFERENCES "admin_users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "admin_withdrawal_unlocks_unlocked_at_idx"
  ON "admin_withdrawal_unlocks" ("unlocked_at" DESC);
