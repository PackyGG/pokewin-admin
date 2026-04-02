-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN "allowed_pages" TEXT[] DEFAULT '{}';

-- Migrate existing role-based permissions to per-user
UPDATE "admin_users" u
SET "allowed_pages" = rp."pages"
FROM "admin_role_permissions" rp
WHERE u."role"::text = rp."role"::text AND u."role" != 'admin';

-- DropTable
DROP TABLE "admin_role_permissions";
