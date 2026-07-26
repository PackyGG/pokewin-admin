UPDATE admin_users
SET allowed_pages = ARRAY[]::text[]
WHERE allowed_pages IS NULL;

ALTER TABLE admin_users
  ALTER COLUMN allowed_pages SET DEFAULT ARRAY[]::text[],
  ALTER COLUMN allowed_pages SET NOT NULL;
