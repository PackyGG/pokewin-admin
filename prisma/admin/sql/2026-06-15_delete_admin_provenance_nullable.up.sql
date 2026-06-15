-- 2026-06-15: Make the "who set/created it" provenance columns NULLABLE so
-- deleting an admin can NULL the attribution instead of being blocked by a
-- RESTRICT/NO-ACTION foreign key. Additive + reversible. The FK to
-- admin_users already permits NULL (no row references a non-existent admin);
-- this only relaxes the NOT NULL constraint on the referencing column so the
-- business/financial row SURVIVES with its provenance dropped to NULL.
--
-- Tables/columns (all verified is_nullable=NO before this change):
--   admin_user_tags.set_by_admin_id            (RESTRICT)
--   excluded_users.excluded_by                 (RESTRICT)
--   admin_excluded_user_balance_v2.set_by_admin_id (RESTRICT)
--   salary_employees.created_by_id             (RESTRICT)
--   salary_payouts.paid_by_id                  (RESTRICT)
--   admin_shifts.created_by_id                 (RESTRICT)
--   creator_deal_estimates.created_by_id       (NO ACTION)

ALTER TABLE "admin_user_tags"                ALTER COLUMN "set_by_admin_id" DROP NOT NULL;
ALTER TABLE "excluded_users"                 ALTER COLUMN "excluded_by"     DROP NOT NULL;
ALTER TABLE "admin_excluded_user_balance_v2" ALTER COLUMN "set_by_admin_id" DROP NOT NULL;
ALTER TABLE "salary_employees"               ALTER COLUMN "created_by_id"   DROP NOT NULL;
ALTER TABLE "salary_payouts"                 ALTER COLUMN "paid_by_id"       DROP NOT NULL;
ALTER TABLE "admin_shifts"                   ALTER COLUMN "created_by_id"   DROP NOT NULL;
ALTER TABLE "creator_deal_estimates"         ALTER COLUMN "created_by_id"   DROP NOT NULL;
