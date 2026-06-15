-- DOWN: re-impose NOT NULL on the provenance columns relaxed by the .up.sql.
-- WARNING: this will FAIL if any of these columns now contains NULL (i.e. if
-- an admin has been deleted and their attribution NULLed). That is by design:
-- you cannot re-tighten the constraint while orphaned-provenance rows exist.
-- Backfill those rows to a valid admin_users.id first, then run this.

ALTER TABLE "admin_user_tags"                ALTER COLUMN "set_by_admin_id" SET NOT NULL;
ALTER TABLE "excluded_users"                 ALTER COLUMN "excluded_by"     SET NOT NULL;
ALTER TABLE "admin_excluded_user_balance_v2" ALTER COLUMN "set_by_admin_id" SET NOT NULL;
ALTER TABLE "salary_employees"               ALTER COLUMN "created_by_id"   SET NOT NULL;
ALTER TABLE "salary_payouts"                 ALTER COLUMN "paid_by_id"       SET NOT NULL;
ALTER TABLE "admin_shifts"                   ALTER COLUMN "created_by_id"   SET NOT NULL;
ALTER TABLE "creator_deal_estimates"         ALTER COLUMN "created_by_id"   SET NOT NULL;
