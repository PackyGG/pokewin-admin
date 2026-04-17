-- Custom role definitions for the granular-permissions system.
-- Four `is_system = true` rows (admin, support, marketing, creator) are
-- seeded by prisma/admin/seed.ts. `capabilities` is a string[] of keys
-- from src/lib/permissions.ts.

-- CreateTable
CREATE TABLE "admin_roles" (
    "id"           UUID            NOT NULL DEFAULT gen_random_uuid(),
    "name"         TEXT            NOT NULL,
    "description"  TEXT,
    "is_system"    BOOLEAN         NOT NULL DEFAULT FALSE,
    "capabilities" TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at"   TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_roles_name_key" ON "admin_roles"("name");

-- AlterTable: add FK column on admin_users
ALTER TABLE "admin_users" ADD COLUMN "role_id" UUID;

-- AddForeignKey
ALTER TABLE "admin_users"
  ADD CONSTRAINT "admin_users_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
