-- admin_excluded_user_balance_v2: per-user editable "Balance 2.0"
-- annotation surfaced on /system/excluded-users. Admin-managed only,
-- never exposed user-side. Mirrors the visual shape of the
-- "Total Deposited" column on that page but is fully editable.
--
-- Storage notes:
--   • Primary key IS the packy.gg user_id (text — better-auth nanoid).
--     Each user has at most one Balance 2.0 value; the action upserts
--     on this key.
--   • set_by_admin_id references admin_users.id so the table can show
--     "last edited by X on date Y". ON DELETE RESTRICT keeps the row
--     from being orphaned by deleting the admin who set it.
--   • balance_v2 is Decimal(20,2) — same precision as every other
--     money column in the admin DB.
--   • notes is optional free-text the operator can attach.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "admin_excluded_user_balance_v2" (
  "target_user_id"  TEXT          NOT NULL,
  "balance_v2"      NUMERIC(20,2) NOT NULL,
  "set_by_admin_id" UUID          NOT NULL,
  "set_at"          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "notes"           TEXT,
  CONSTRAINT "admin_excluded_user_balance_v2_pkey" PRIMARY KEY ("target_user_id"),
  CONSTRAINT "admin_excluded_user_balance_v2_set_by_admin_id_fkey"
    FOREIGN KEY ("set_by_admin_id")
    REFERENCES "admin_users"("id")
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "admin_excluded_user_balance_v2_set_at_idx"
  ON "admin_excluded_user_balance_v2" ("set_at" DESC);
