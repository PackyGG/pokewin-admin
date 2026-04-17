-- Admin per-user preferences (theme, timezone, date format, etc.).
-- Stored as JSONB so additional preference slots can be added without
-- schema churn. Read/write helpers in src/lib/admin-preferences.ts
-- parse the blob with a typed default so missing keys never crash.

ALTER TABLE "admin_users" ADD COLUMN "preferences" JSONB;
