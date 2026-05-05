-- salary_employees: rename `name` to `discord_name` (we use Discord
-- usernames for the actual recipient identity now) + add a `cadence`
-- column for pay frequency.
--
-- Both blocks are idempotent so a re-run on a partially-applied env
-- is safe.

-- Add `cadence` if missing. TEXT (not enum) so adding new
-- frequencies later doesn't require another migration.
ALTER TABLE "salary_employees"
  ADD COLUMN IF NOT EXISTS "cadence" TEXT NOT NULL DEFAULT 'monthly';

-- Rename `name` → `discord_name` if the old column still exists.
-- IF EXISTS makes this safe to re-run after the rename has happened
-- (the second run is a no-op).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'salary_employees'
      AND column_name = 'name'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'salary_employees'
      AND column_name = 'discord_name'
  )
  THEN
    ALTER TABLE "salary_employees" RENAME COLUMN "name" TO "discord_name";
  END IF;
END $$;
