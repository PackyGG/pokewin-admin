-- excluded_users: admin-managed blacklist of packy.gg user IDs
-- whose activity is filtered out of dashboard / analytics / PnL / wager
-- aggregates (race queries deliberately ignore this list).
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "excluded_users" (
  "user_id"     TEXT        NOT NULL,
  "reason"      TEXT,
  "excluded_by" UUID        NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "excluded_users_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "excluded_users_excluded_by_fkey"
    FOREIGN KEY ("excluded_by")
    REFERENCES "admin_users"("id")
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "excluded_users_created_at_idx"
  ON "excluded_users" ("created_at" DESC);

-- Seed the first excluded user, attributed to the motha admin so the
-- foreign-key constraint is satisfied and the audit trail starts
-- pointing at a real admin. ON CONFLICT keeps the migration idempotent
-- in case it's re-applied against a DB where the row already exists.
INSERT INTO "excluded_users" ("user_id", "reason", "excluded_by")
SELECT
  'R3cqeAyDdNQNbltwnQQJuJUHiqjiNw98'::text,
  'Initial blacklist entry'::text,
  au.id
FROM "admin_users" au
WHERE au.username = 'motha'
LIMIT 1
ON CONFLICT ("user_id") DO NOTHING;
