-- Make expense attribution nullable so deleting an admin can NULL
-- created_by_id (preserving the company financial record) instead of
-- hard-deleting expenses / recurring_expenses rows. Mirrors the
-- salary_employees / admin_shifts provenance model. Idempotent.

ALTER TABLE expenses
  ALTER COLUMN created_by_id DROP NOT NULL;

ALTER TABLE recurring_expenses
  ALTER COLUMN created_by_id DROP NOT NULL;
