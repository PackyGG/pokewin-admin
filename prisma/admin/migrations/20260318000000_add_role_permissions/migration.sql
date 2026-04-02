-- CreateTable
CREATE TABLE "admin_role_permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role" "admin_role" NOT NULL,
    "pages" TEXT[],

    CONSTRAINT "admin_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_role_permissions_role_key" ON "admin_role_permissions"("role");

-- Seed default permissions
INSERT INTO "admin_role_permissions" ("role", "pages") VALUES
  ('support', ARRAY['/battles', '/chat']),
  ('marketing', ARRAY['/rewards', '/rewards/rakeback', '/rewards/raffles', '/rewards/races', '/rewards/leaderboards', '/rewards/level-up', '/promo-codes', '/gift-cards', '/vouchers', '/rain', '/chat']);
